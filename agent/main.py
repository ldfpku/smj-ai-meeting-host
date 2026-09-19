from __future__ import annotations

import asyncio
import ctypes
from ctypes import wintypes
from io import BytesIO
import json
import logging
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Dict, List

from PIL import Image
from dotenv import load_dotenv
from google import genai
from google.genai import types
from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    AutoSubscribe,
    JobContext,
    cli,
    function_tool,
    llm,
    utils,
)
from livekit.agents.voice.turn import (
    EndpointingOptions,
    TurnHandlingOptions,
)
from livekit.plugins import google

# Load .env.local from current directory or parent directory
load_dotenv(dotenv_path=".env.local")
load_dotenv(dotenv_path="../.env.local")

logger = logging.getLogger("gemini-playground")
logger.setLevel(logging.INFO)

# Suppress OpenTelemetry attribute warnings
logging.getLogger("opentelemetry.attributes").setLevel(logging.ERROR)


def model_supports_proactive_audio(model: str) -> bool:
    """Whether the Live model honours ``proactivity`` (proactive audio).

    Google documents proactive audio (and affective dialog) as *not supported*
    on Gemini 3.1 Flash Live; only the 2.5 native-audio models use it. Passing
    ``proactivity=True`` anyway makes livekit-plugins-google move the whole
    session onto the ``v1alpha`` API surface for no benefit.
    """
    return "3.1" not in model


#: Cue that makes the moderator deliver the opening announcement. It is worded
#: as a user-side prompt because on gemini-3.1 it is delivered as realtime text
#: input (see SessionManager.cue_model), not as model instructions.
OPENING_CUE_MEETING = (
    "【系统提示】会议现在开始。请立即按照你的开场要求开口："
    "清晰简短地播报会议名称、总时长与各项议题，然后宣布讨论正式开始。"
    "不要复述本提示。"
)
OPENING_CUE_DEFAULT = (
    "Please begin the interaction with the user in a manner consistent with your instructions."
)


def _auto_suppress_c_assert_dialogs():
    """
    On Windows, livekit_ffi.dll has an internal debug assertion in soxr-sys (fft4g_cache.h line 13: LSX_FFT_BR == NULL)
    which triggers a harmless MSVC Assertion Failed dialog popup.
    This helper sets CRT error modes to suppress it and runs a background daemon thread
    to automatically dismiss any assertion dialogs by posting IDIGNORE (5).
    """
    if sys.platform != "win32":
        return

    # 1. Try to set CRT error mode to stderr instead of msgbox
    for lib_name in ["ucrtbase", "msvcrt", "vcruntime140"]:
        try:
            lib = ctypes.cdll.LoadLibrary(lib_name)
            if hasattr(lib, "_set_error_mode"):
                lib._set_error_mode(1)  # _OUT_TO_STDERR
            if hasattr(lib, "_CrtSetReportMode"):
                lib._CrtSetReportMode(2, 0)  # _CRT_ASSERT -> 0 (no report)
        except Exception:
            pass

    try:
        ctypes.windll.kernel32.SetErrorMode(0x0001 | 0x0002)  # SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX
    except Exception:
        pass

    # 2. Start a background daemon thread to auto-dismiss any popup if it still appears
    def watcher():
        user32 = ctypes.windll.user32
        while True:
            try:
                hwnd = user32.FindWindowW(None, "Microsoft Visual C++ Runtime Library")
                if hwnd:
                    user32.PostMessageW(hwnd, 0x0111, 5, 0)  # WM_COMMAND, IDIGNORE
            except Exception:
                pass
            time.sleep(0.2)

    t = threading.Thread(target=watcher, daemon=True)
    t.start()


# Initialize assert suppression immediately
_auto_suppress_c_assert_dialogs()


@dataclass
class SessionConfig:
    gemini_api_key: str
    instructions: str
    model: str
    voice: str
    temperature: float
    max_response_output_tokens: str | int
    modalities: list[str]
    nano_banana_enabled: bool = False
    meeting_config: dict | None = None

    def to_dict(self):
        return {k: v for k, v in asdict(self).items() if k != "gemini_api_key"}

    @staticmethod
    def _modalities_from_string(
        modalities: str,
    ) -> list[str]:
        modalities_map: Dict[str, List[str]] = {
            "text_and_audio": ["TEXT", "AUDIO"],
            "text_only": ["TEXT"],
            "audio_only": ["AUDIO"],
        }
        return modalities_map.get(modalities, modalities_map["audio_only"])

    def __eq__(self, other) -> bool:
        return self.to_dict() == other.to_dict()


def parse_session_config(data: Dict[str, Any]) -> SessionConfig:
    # Parse nano_banana_enabled - handle both boolean and string types
    nano_banana_value = data.get("nano_banana_enabled", False)
    if isinstance(nano_banana_value, bool):
        nano_banana_enabled = nano_banana_value
    elif isinstance(nano_banana_value, str):
        nano_banana_enabled = nano_banana_value.lower() == "true"
    else:
        nano_banana_enabled = bool(nano_banana_value)

    meeting_config_raw = data.get("meeting_config")
    meeting_config = None
    if isinstance(meeting_config_raw, dict):
        meeting_config = meeting_config_raw
    elif isinstance(meeting_config_raw, str) and meeting_config_raw.strip():
        try:
            meeting_config = json.loads(meeting_config_raw)
        except Exception:
            meeting_config = None

    logger.debug(f"Parsing config - nano_banana_enabled: {nano_banana_value} -> {nano_banana_enabled}, meeting: {bool(meeting_config)}")

    config = SessionConfig(
        gemini_api_key=data.get("gemini_api_key", ""),
        instructions=data.get("instructions", ""),
        model=data.get("model", "gemini-3.1-flash-live-preview"),
        voice=data.get("voice", "Puck"),
        temperature=float(data.get("temperature", 0.8)),
        max_response_output_tokens=
            "inf" if data.get("max_output_tokens") == "inf"
            else int(data.get("max_output_tokens") or 2048),
        modalities=SessionConfig._modalities_from_string(
            data.get("modalities", "audio_only")
        ),
        nano_banana_enabled=nano_banana_enabled,
        meeting_config=meeting_config,
    )
    return config


# Module-level AgentServer: `lk agent dev` and `python -m livekit.agents start`
# import this file and look for an AgentServer named `server`
# (see livekit.agents.cli.discover), so it has to live at module scope.
server = AgentServer()


@server.rtc_session(agent_name="gemini-playground")
async def entrypoint(ctx: JobContext):
    logger.info(f"connecting to room {ctx.room.name}")
    await ctx.connect(auto_subscribe=AutoSubscribe.AUDIO_ONLY)

    participant = await ctx.wait_for_participant()

    # Parse metadata with error handling
    try:
        metadata = json.loads(participant.metadata) if participant.metadata else {}
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse participant metadata: {e}. Using default config.")
        metadata = {}

    config = parse_session_config(metadata)

    session_manager = SessionManager(config)
    await session_manager.start_session(ctx, participant)

    logger.info("agent started")


def create_generate_image_tool(session_manager: SessionManager):
    """Factory function to create the generate_image tool with access to session_manager"""

    raw_schema = {
        "type": "function",
        "name": "generate_image",
        "description": "Generate an image using Nano Banana and send it to the user",
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Detailed, specific description of the image to generate (e.g., 'a labelled cross-section diagram of a progressive cavity drilling motor power section, showing stator elastomer and rotor lobes'), not simply a few words. Not a generic prompt such as 'a diagram' or 'random image'."
                }
            },
            "required": [
                "prompt"
            ],
            "additionalProperties": False
        }
    }

    @function_tool(raw_schema=raw_schema)
    async def generate_image(raw_arguments: dict) -> str:
        prompt = raw_arguments["prompt"]

        try:
            client = genai.Client(api_key=session_manager.current_config.gemini_api_key)

            response = await asyncio.to_thread(
                lambda: client.models.generate_images(
                    model='imagen-4.0-fast-generate-001',
                    prompt=prompt,
                    config=types.GenerateImagesConfig(
                        number_of_images=1,
                        output_mime_type='image/jpeg',
                    ),
                )
            )

            image_bytes = response.generated_images[0].image.image_bytes

            img = Image.open(BytesIO(image_bytes))
            img.thumbnail((512, 512), Image.Resampling.LANCZOS)

            buffer = BytesIO()
            img.save(buffer, format='JPEG', quality=90, optimize=True)
            image_data = buffer.getvalue()

            if session_manager.ctx and session_manager.participant:
                await session_manager.send_image_to_frontend(prompt, image_data)

            return "I've generated the image and sent it to your screen!"
        except Exception as e:
            logger.error(f"Image generation failed: {e}")
            return f"Sorry, I couldn't generate that image. Error: {str(e)}"

    return generate_image


#: 决议四要素——SMJ 要求每条决议都必须带齐，缺一不可（与前端 missingDecisionFields 保持一致）
DECISION_REQUIRED_FIELDS = (
    ("owner", "责任人"),
    ("dueDate", "完成时限"),
    ("verification", "验证方式"),
    ("evidence", "关闭证据"),
)


def _is_blank(value) -> bool:
    if not isinstance(value, str):
        return not value
    stripped = value.strip()
    return not stripped or stripped == "待定"


def missing_decision_fields(decision: dict) -> list[str]:
    return [label for key, label in DECISION_REQUIRED_FIELDS if _is_blank(decision.get(key))]


def create_get_meeting_timer_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "get_meeting_timer",
        "description": "获取当前会议的已用时长、剩余时长、总计划时间、当前议题，以及本议题尚未点名表态的必须发言人、要素不全的决议清单。",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def get_meeting_timer(raw_arguments: dict) -> str:
        elapsed_secs = session_manager.get_elapsed_seconds()
        elapsed_mins = elapsed_secs // 60
        rem_secs = elapsed_secs % 60
        cfg = session_manager.current_config.meeting_config or {}
        total_mins = cfg.get("totalDurationMinutes", 0)
        agendas = cfg.get("agendas", [])
        idx = session_manager.current_agenda_index

        parts: list[str] = []
        if 0 <= idx < len(agendas):
            cur = agendas[idx]
            cur_title = cur.get("title", f"议题 {idx + 1}")
            cur_duration = cur.get("durationMinutes", 0)
            cur_goal = cur.get("goal", "")
            parts.append(
                f"会议已进行 {elapsed_mins}分{rem_secs}秒 (总预计 {total_mins} 分钟)。"
                f"当前进行第 {idx + 1}/{len(agendas)} 项议题：【{cur_title}】"
                f"(计划用时 {cur_duration} 分钟，核心目标: {cur_goal})。"
            )
        else:
            parts.append(
                f"会议已进行 {elapsed_mins}分{rem_secs}秒 (总预计 {total_mins} 分钟)。目前所有计划议程已讨论完毕。"
            )

        pending = session_manager.pending_required_speakers()
        if pending:
            names = "、".join(
                (a.get("name") or a.get("role") or "未具名") for a in pending
            )
            parts.append(
                f"本议题还有 {len(pending)} 位【必须发言】人员尚未点名征询：{names}。"
                f"请在推进议题前逐一点名（调用 request_speaker）——沉默不等于同意。"
            )

        incomplete = session_manager.incomplete_decisions()
        if incomplete:
            details = "；".join(
                f"「{d.get('decision', '')[:20]}」缺 {'、'.join(m)}" for d, m in incomplete
            )
            parts.append(
                f"有 {len(incomplete)} 条决议要素不全：{details}。请当场追问补齐。"
            )

        if not session_manager.decisions_for_current_agenda() and not session_manager.open_items_for_current_agenda():
            parts.append("当前议题尚未产生任何决议或未决事项，切勿让它空过。")

        return " ".join(parts)

    return get_meeting_timer


def create_advance_agenda_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "advance_agenda",
        "description": "推进会议到下一项或指定项议程（序号从1开始），并在参会人前台看板同步推进状态。",
        "parameters": {
            "type": "object",
            "properties": {
                "item_index": {
                    "type": "integer",
                    "description": "推进到的议题编号（从1开始，例如2表示推进到第2项议题，3表示第3项）",
                },
                "summary": {
                    "type": "string",
                    "description": "对上一项议题的1句话精要总结或承上启下的过渡语",
                },
            },
            "required": ["item_index"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def advance_agenda(raw_arguments: dict) -> str:
        try:
            item_index = int(raw_arguments.get("item_index", 1))
        except (ValueError, TypeError):
            item_index = 1
        summary = raw_arguments.get("summary", "")

        # 议而不决闸门：当前议题既无决议也无未决事项时，不允许直接翻页
        leaving_idx = session_manager.current_agenda_index
        target_idx = session_manager.clamp_agenda_index(item_index)
        if target_idx > leaving_idx:
            has_decision = bool(session_manager.decisions_for_current_agenda())
            has_open = bool(session_manager.open_items_for_current_agenda())
            if not has_decision and not has_open:
                return (
                    f"【暂不推进】议题【{session_manager.current_agenda_title()}】"
                    f"至今没有任何决议，也没有登记未决事项，属于典型的「议而不决」。"
                    f"请先追问拍板结论并调用 record_decision（须带齐 责任人/完成时限/验证方式/关闭证据）；"
                    f"若确实定不下来，就调用 record_open_item 记为未决事项并说明升级路径，"
                    f"然后再调用 advance_agenda 推进。"
                )
            pending = session_manager.pending_required_speakers()
            if pending:
                names = "、".join(
                    (a.get("name") or a.get("role") or "未具名") for a in pending
                )
                return (
                    f"【暂不推进】还有 {len(pending)} 位【必须发言】人员没有被点名征询：{names}。"
                    f"请先逐一调用 request_speaker 点名并听取表态——沉默不等于同意——再推进议题。"
                )

        session_manager.current_agenda_index = target_idx
        # 换议题即清空本议题的点名记录
        session_manager.called_attendee_ids = set()

        agendas = session_manager.meeting_agendas()

        await session_manager.publish_meeting_data({
            "type": "advance_agenda",
            "currentAgendaIndex": target_idx,
            "summary": summary,
        })

        title = agendas[target_idx].get("title", f"议题 {target_idx + 1}") if 0 <= target_idx < len(agendas) else f"第 {target_idx + 1} 项"
        note = ""
        if target_idx != item_index - 1:
            note = f"（请求的第 {item_index} 项超出议程范围，已定位到第 {target_idx + 1} 项）"
        return f"会议议程已更新至第 {target_idx + 1} 项：【{title}】{note}。前台看板已同步更新。"

    return advance_agenda


def create_record_decision_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "record_decision",
        "description": (
            "记录会议中达成的明确决议或 Action Item，同步展示在前台看板和最终纪要中。"
            "公司要求每条决议必须带齐四要素：责任人、完成时限、验证方式、关闭证据。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "decision": {
                    "type": "string",
                    "description": "敲定的决策结论、执行方案或待办事项具体内容",
                },
                "agenda_title": {
                    "type": "string",
                    "description": "该决议对应的议题标题（可选，默认归属于当前进行中的议题）",
                },
                "owner": {
                    "type": "string",
                    "description": "【四要素之一】明确到人的责任人姓名或岗位（如'杨部长'、'产品线经理'）",
                },
                "due_date": {
                    "type": "string",
                    "description": "【四要素之一】完成时限（如'本周五'、'10月15日前'、'下次协同会前'）",
                },
                "verification": {
                    "type": "string",
                    "description": "【四要素之一】验证方式——用什么办法确认这件事真的做到了（如'首件鉴定合格'、'MES 工艺路线可查'、'账龄表复核'）",
                },
                "closure_evidence": {
                    "type": "string",
                    "description": "【四要素之一】关闭证据——拿什么作为闭环凭据（如'QHSE 首件鉴定报告'、'受控入档的图纸清单'、'回款到账流水'）",
                },
                "owner_dept": {
                    "type": "string",
                    "description": "归口部门（如'技术研发部'、'质量安全部'），依据决议内容判断",
                },
                "process_id": {
                    "type": "string",
                    "description": "关联的业务流程编号（M-01…H-06，如'P-01'、'Q-03'、'T-03'），无法判断则留空",
                },
            },
            "required": ["decision"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def record_decision(raw_arguments: dict) -> str:
        decision_text = raw_arguments.get("decision", "")
        agendas = session_manager.meeting_agendas()
        idx = session_manager.current_agenda_index
        default_agenda_title = agendas[idx].get("title", "") if 0 <= idx < len(agendas) else "通用决议"
        agenda_title = raw_arguments.get("agenda_title") or default_agenda_title

        # 补齐四要素时模型会带着同一条结论再调用一次：按「议题+结论文本」做 upsert，
        # 复用原 id 覆盖，避免看板上出现两条内容相同、完整度不同的决议。
        existing = next(
            (
                d
                for d in session_manager.decisions
                if d.get("agendaTitle") == agenda_title
                and d.get("decision", "").strip() == decision_text.strip()
            ),
            None,
        )

        decision_item = {
            "id": existing["id"] if existing else f"dec-{uuid.uuid4().hex[:8]}",
            "agendaTitle": agenda_title,
            "decision": decision_text,
            "owner": raw_arguments.get("owner") or "",
            "dueDate": raw_arguments.get("due_date") or "",
            "verification": raw_arguments.get("verification") or "",
            "evidence": raw_arguments.get("closure_evidence") or "",
            "ownerDept": raw_arguments.get("owner_dept") or "",
            "processId": (raw_arguments.get("process_id") or "").strip().upper(),
            "timestamp": existing["timestamp"] if existing else int(time.time() * 1000),
        }
        if existing:
            session_manager.decisions[session_manager.decisions.index(existing)] = decision_item
        else:
            session_manager.decisions.append(decision_item)

        await session_manager.publish_meeting_data({
            "type": "new_decision",
            "decision": decision_item,
        })

        missing = missing_decision_fields(decision_item)
        base = (
            f"已记录决议：【{decision_text}】（议题：{agenda_title}，"
            f"责任人：{decision_item['owner'] or '缺'}，"
            f"完成时限：{decision_item['dueDate'] or '缺'}，"
            f"验证方式：{decision_item['verification'] or '缺'}，"
            f"关闭证据：{decision_item['evidence'] or '缺'}），已同步至前台看板。"
        )
        if missing:
            return (
                base
                + f" 但该决议仍缺少四要素中的：{('、'.join(missing))}。"
                f"请立即当场追问补齐，例如「这条由谁负责？什么时候完成？用什么方式验证？拿什么作为关闭证据？」，"
                f"补齐后重新调用 record_decision 覆盖记录；若确实问不齐，改用 record_open_item 记为未决事项。"
            )
        return base + " 四要素齐全，请口头向全场复述确认一次。"

    return record_decision


def create_record_open_item_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "record_open_item",
        "description": (
            "记录会上未能形成结论的未决事项，并写明升级路径。"
            "凡是争执不下、缺数据、缺人、跨部门扯皮而定不了的事项，都必须登记，绝不能不了了之。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "issue": {
                    "type": "string",
                    "description": "未能拍板的事项内容",
                },
                "reason": {
                    "type": "string",
                    "description": "为什么没能当场定下来（如'缺上月账龄数据'、'需供应商确认交期'、'两个部门口径不一致'）",
                },
                "owner": {
                    "type": "string",
                    "description": "会后跟进的责任人姓名或岗位",
                },
                "escalate_to": {
                    "type": "string",
                    "description": "升级路径（默认使用本次会议配置的升级路径，如'总经理签批并留档'）",
                },
                "agenda_title": {
                    "type": "string",
                    "description": "所属议题标题（可选，默认当前议题）",
                },
            },
            "required": ["issue"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def record_open_item(raw_arguments: dict) -> str:
        issue = raw_arguments.get("issue", "")
        agenda_title = raw_arguments.get("agenda_title") or session_manager.current_agenda_title()
        escalate_to = raw_arguments.get("escalate_to") or session_manager.escalation_path()

        open_item = {
            "id": f"open-{uuid.uuid4().hex[:8]}",
            "agendaTitle": agenda_title,
            "issue": issue,
            "reason": raw_arguments.get("reason") or "",
            "owner": raw_arguments.get("owner") or "",
            "escalateTo": escalate_to,
            "timestamp": int(time.time() * 1000),
        }
        session_manager.open_items.append(open_item)

        await session_manager.publish_meeting_data({
            "type": "new_open_item",
            "openItem": open_item,
        })

        return (
            f"已登记未决事项：【{issue}】（议题：{agenda_title}，跟进人：{open_item['owner'] or '待定'}，"
            f"升级路径：{escalate_to}）。请口头明确宣布："
            f"「这条今天定不了，记为未决事项，由{open_item['owner'] or '相关责任人'}跟进，升级到{escalate_to}。」"
        )

    return record_open_item


def create_request_speaker_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "request_speaker",
        "description": (
            "点名征询某位参会人的意见，前台看板会高亮该参会人。"
            "本公司参会人普遍不会主动表态，沉默不等于同意——议题收尾前必须对所有【必须发言】人员逐一点名。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "attendee_name": {
                    "type": "string",
                    "description": "要点名的参会人姓名或岗位，须来自会议参会人名单",
                },
                "reason": {
                    "type": "string",
                    "description": "点名征询的具体问题或角度（如'请从质量口径说明是否接受该让步'）",
                },
            },
            "required": ["attendee_name"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def request_speaker(raw_arguments: dict) -> str:
        name = raw_arguments.get("attendee_name", "")
        reason = raw_arguments.get("reason") or ""
        attendee = session_manager.find_attendee(name)

        if attendee is None:
            roster = session_manager.meeting_attendees()
            known = "、".join(
                (a.get("name") or a.get("role") or "") for a in roster if (a.get("name") or a.get("role"))
            )
            return (
                f"参会人名单中没有找到「{name}」。"
                + (f"当前名单为：{known}。请改用名单中的称呼点名。" if known else "本次会议尚未登记参会人名单，可直接口头点名。")
            )

        attendee_id = attendee.get("id", "")
        session_manager.called_attendee_ids.add(attendee_id)

        await session_manager.publish_meeting_data({
            "type": "roll_call",
            "attendeeId": attendee_id,
            "attendeeName": attendee.get("name") or attendee.get("role") or name,
            "reason": reason,
        })

        label = attendee.get("name") or attendee.get("role") or name
        remaining = len(session_manager.pending_required_speakers())
        return (
            f"已在看板高亮点名 {label}。请立即开口征询："
            f"「请{label}就本议题明确表个态"
            + (f"，{reason}" if reason else "")
            + "：你的意见是什么？有没有不同看法？」"
            + (f" 本议题还剩 {remaining} 位必须发言人员未点名。" if remaining else " 本议题必须发言人员已全部点名。")
        )

    return request_speaker


def create_warn_topic_drift_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "warn_topic_drift",
        "description": "当参会人员讨论明显偏离当前议程核心目标时，触发前台看板醒目的跑题黄牌警示与提示音，并立即开麦强势切入叫停拉回。",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "讨论偏离当前主题的简要说明（例如：'正在过瓶颈工序，话题却跑到了明年设备采购预算'）",
                },
            },
            "required": ["reason"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def warn_topic_drift(raw_arguments: dict) -> str:
        reason = raw_arguments.get("reason", "讨论内容偏离当前议程核心目标")

        await session_manager.publish_meeting_data({
            "type": "drift_warning",
            "active": True,
            "reason": reason,
        })

        return (
            f"已在前台看板亮起跑题黄牌警示并鸣响提示音：{reason}。"
            f"请立即用清脆响亮、毋庸置疑的声音强势切入叫停：“打扰一下，请大家先暂停一下！”，"
            f"指出偏离并强行要求大家立即回到当前议程讨论，严禁等待对方继续展开！"
        )

    return warn_topic_drift


def create_meeting_tools(session_manager: SessionManager):
    return [
        create_get_meeting_timer_tool(session_manager),
        create_advance_agenda_tool(session_manager),
        create_record_decision_tool(session_manager),
        create_record_open_item_tool(session_manager),
        create_request_speaker_tool(session_manager),
        create_warn_topic_drift_tool(session_manager),
    ]


class PlaygroundAgent(Agent):
    """Custom agent class for the playground"""
    def __init__(self, instructions: str, tools=None, chat_ctx=None):
        if chat_ctx:
            super().__init__(instructions=instructions, tools=tools or [], chat_ctx=chat_ctx)
        else:
            super().__init__(instructions=instructions, tools=tools or [])
        self.session_manager = None


class SessionManager:
    def __init__(self, config: SessionConfig):
        self.current_session: AgentSession | None = None
        self.current_config: SessionConfig = config
        self.ctx: JobContext | None = None
        self.participant: rtc.RemoteParticipant | None = None
        self.current_agent: PlaygroundAgent | None = None

        # Meeting state
        self.meeting_start_time: float | None = None
        self.current_agenda_index: int = 0
        self.decisions: list[dict] = []
        self.open_items: list[dict] = []
        self.called_attendee_ids: set[str] = set()
        self.overtime_alerted: set[int] = set()
        self.monitor_task: asyncio.Task | None = None

    def get_elapsed_seconds(self) -> int:
        if self.meeting_start_time is None:
            return 0
        return int(time.time() - self.meeting_start_time)

    # ---- meeting helpers -------------------------------------------------

    def meeting_agendas(self) -> list[dict]:
        cfg = self.current_config.meeting_config or {}
        agendas = cfg.get("agendas", [])
        return agendas if isinstance(agendas, list) else []

    def meeting_attendees(self) -> list[dict]:
        cfg = self.current_config.meeting_config or {}
        attendees = cfg.get("attendees", [])
        return attendees if isinstance(attendees, list) else []

    def escalation_path(self) -> str:
        cfg = self.current_config.meeting_config or {}
        return cfg.get("escalationPath") or "提请总经理签批并留档"

    def current_agenda_title(self) -> str:
        agendas = self.meeting_agendas()
        idx = self.current_agenda_index
        if 0 <= idx < len(agendas):
            return agendas[idx].get("title", f"议题 {idx + 1}")
        return "当前议题"

    def clamp_agenda_index(self, one_based: int) -> int:
        """1-based -> 0-based, bounded to the agenda list.

        Without the upper bound an out-of-range index pushes the pointer past
        the end of the agenda, after which the kanban and every tool that reads
        the current item silently fall back to 'no agenda'.
        """
        agendas = self.meeting_agendas()
        if not agendas:
            return 0
        return max(0, min(len(agendas) - 1, one_based - 1))

    def find_attendee(self, name: str) -> dict | None:
        """Resolve a spoken name/role to a configured attendee."""
        if not name:
            return None
        needle = name.strip()
        if not needle:
            return None
        attendees = self.meeting_attendees()
        for a in attendees:
            if a.get("name", "").strip() == needle:
                return a
        for a in attendees:
            if a.get("role", "").strip() == needle:
                return a
        # tolerate the model saying "杨部长" / "生产制造部部长 张三"
        for a in attendees:
            nm = a.get("name", "").strip()
            role = a.get("role", "").strip()
            if (nm and nm in needle) or (role and role in needle):
                return a
        return None

    def pending_required_speakers(self) -> list[dict]:
        """Required attendees who have not been called on for this agenda yet."""
        return [
            a
            for a in self.meeting_attendees()
            if a.get("required") and a.get("id") not in self.called_attendee_ids
        ]

    def incomplete_decisions(self) -> list[tuple[dict, list[str]]]:
        """Decisions missing any of the four mandatory elements."""
        out: list[tuple[dict, list[str]]] = []
        for d in self.decisions:
            missing = missing_decision_fields(d)
            if missing:
                out.append((d, missing))
        return out

    def decisions_for_current_agenda(self) -> list[dict]:
        title = self.current_agenda_title()
        return [d for d in self.decisions if d.get("agendaTitle") == title]

    def open_items_for_current_agenda(self) -> list[dict]:
        title = self.current_agenda_title()
        return [o for o in self.open_items if o.get("agendaTitle") == title]

    async def publish_meeting_data(self, payload: dict):
        if not self.ctx or not self.ctx.room or not self.ctx.room.local_participant:
            return
        try:
            payload_str = json.dumps(payload, ensure_ascii=False)
            await self.ctx.room.local_participant.publish_data(
                payload=payload_str,
                topic="meeting_update",
                reliable=True,
            )
        except Exception as e:
            logger.error(f"Failed to publish meeting data: {e}")

    async def _meeting_time_monitor(self):
        """Background monitor for meeting time and agenda alerts"""
        logger.info("Meeting time monitor started")
        try:
            while True:
                await asyncio.sleep(10)
                if not self.ctx or not self.ctx.room:
                    continue
                config = self.current_config.meeting_config
                if not config:
                    break

                elapsed = self.get_elapsed_seconds()
                agendas = config.get("agendas", [])
                idx = self.current_agenda_index

                # Periodically sync elapsed time to frontend
                await self.publish_meeting_data({
                    "type": "state_sync",
                    "state": {
                        "elapsedSeconds": elapsed,
                        "currentAgendaIndex": idx,
                    }
                })

                # Check agenda overtime alert
                if 0 <= idx < len(agendas) and idx not in self.overtime_alerted:
                    accumulated_target_secs = sum(a.get("durationMinutes", 0) for a in agendas[:idx+1]) * 60
                    if elapsed > accumulated_target_secs:
                        self.overtime_alerted.add(idx)
                        cur_title = agendas[idx].get("title", f"议题 {idx + 1}")
                        logger.info(f"Agenda {idx + 1} ({cur_title}) has exceeded planned time")

                        await self.publish_meeting_data({
                            "type": "drift_warning",
                            "active": True,
                            "reason": f"【时间提醒】议题「{cur_title}」已达到计划用时，建议尽快确认决议并推进至下一议题。"
                        })
        except asyncio.CancelledError:
            logger.info("Meeting time monitor cancelled")
        except Exception as e:
            logger.error(f"Error in meeting time monitor: {e}")

    # ---- making the moderator speak on demand -----------------------------

    def _realtime_session(self) -> llm.RealtimeSession | None:
        if self.current_agent is None:
            return None
        try:
            return self.current_agent.realtime_llm_session
        except RuntimeError:
            # the agent is not running (yet, or any more)
            return None

    def cue_model(self, text: str, *, allow_interruptions: bool = True):
        """Make the model speak now (opening announcement, forced intervention…).

        Which mechanism is used depends on the active Live model:

        * Models with a mutable chat context (gemini-2.5 native audio) go through
          ``AgentSession.generate_reply`` as before.
        * ``gemini-3.1-flash-live-preview`` only accepts ``client_content`` as the
          initial history, so livekit-plugins-google 1.8 rejects ``generate_reply``
          up front ("generate_reply is not compatible with ..." in the logs). That
          is why the greeting and 立即纠偏 never produced any speech on 3.1. Per the
          Live API docs, mid-session text must be sent with
          ``send_realtime_input(text=...)``; the plugin has no public entry point
          for that, so the cue is queued on its client-event channel as realtime
          text input. The model answers it like a spoken turn and the reply flows
          through the usual ``generation_created`` path, so it is scheduled and
          played exactly like any other model turn.

        Returns the SpeechHandle when ``generate_reply`` was used, else None.
        Never raises; failures are logged.
        """
        session = self.current_session
        if session is None:
            logger.warning("cue_model called without an active session")
            return None

        rt = self._realtime_session()
        if rt is not None and not rt.capabilities.mutable_chat_context:
            send = getattr(rt, "_send_client_event", None)
            if send is not None:
                send(types.LiveClientRealtimeInput(text=text))
                logger.info(
                    f"cue queued as realtime text input for '{rt.realtime_model.model}'"
                )
                return None
            logger.warning(
                "realtime session exposes no _send_client_event; "
                "falling back to generate_reply"
            )

        try:
            return session.generate_reply(
                instructions=text,
                allow_interruptions=allow_interruptions,
            )
        except RuntimeError as e:
            logger.error(f"failed to cue the model: {e}")
            return None

    def create_session(self, config: SessionConfig) -> AgentSession:
        """Create an AgentSession with the given configuration"""
        is_meeting = bool(config.meeting_config)
        llm_kwargs = {
            "model": config.model,
            "voice": config.voice,
            "temperature": config.temperature,
            "max_output_tokens": int(config.max_response_output_tokens) if config.max_response_output_tokens != "inf" else None,
            "modalities": config.modalities,
            "api_key": config.gemini_api_key,
            # Without context-window compression an audio-only Live session is
            # capped at 15 minutes; a 60-minute meeting needs the sliding window.
            # (Connection lifetime is still ~10 min: the plugin reconnects on
            # GoAway with the session-resumption handle it already requests.)
            "context_window_compression": types.ContextWindowCompressionConfig(
                sliding_window=types.SlidingWindow()
            ),
        }

        session_kwargs = {}

        if is_meeting:
            proactive = model_supports_proactive_audio(config.model)
            logger.info(
                "Enabling Meeting Moderator audio parameters: "
                f"proactive={proactive}, silence_duration_ms=250, NO_INTERRUPTION"
            )
            if proactive:
                llm_kwargs["proactivity"] = True
            else:
                logger.info(
                    f"'{config.model}' does not support proactive audio; the model "
                    "answers every detected turn, so silence during on-topic "
                    "discussion relies on the instructions alone"
                )
            llm_kwargs["realtime_input_config"] = types.RealtimeInputConfig(
                automatic_activity_detection=types.AutomaticActivityDetection(
                    silence_duration_ms=250,
                    end_of_speech_sensitivity=types.EndSensitivity.END_SENSITIVITY_HIGH,
                ),
                activity_handling=types.ActivityHandling.NO_INTERRUPTION,
            )
            # 不可打断由 Gemini 服务端的 activity_handling=NO_INTERRUPTION 负责：
            # 插件在该模式下会直接忽略 interrupt()。这里不能再把会话层的
            # InterruptionOptions(enabled=False) 叠加上去——RealtimeModel 使用服务端
            # 轮次检测时，livekit-agents >= 1.8 会在 session.start() 抛出
            # "allow_interruptions cannot be False"，job 崩溃退出房间，前端随即
            # 弹出"主持人已断开"。
            session_kwargs["turn_handling"] = TurnHandlingOptions(
                endpointing=EndpointingOptions(
                    min_delay=0.15,
                    max_delay=0.4,
                    mode="fixed",
                ),
            )

        session_kwargs["llm"] = google.realtime.RealtimeModel(**llm_kwargs)
        session = AgentSession(**session_kwargs)
        return session

    async def start_session(self, ctx: JobContext, participant: rtc.RemoteParticipant):
        """Start the initial agent session"""
        self.ctx = ctx
        self.participant = participant

        tools = []
        if self.current_config.nano_banana_enabled:
            logger.info("Nano Banana tool enabled 🍌")
            tools.append(create_generate_image_tool(self))

        if self.current_config.meeting_config:
            logger.info("Meeting Moderator tools enabled 📋")
            self.meeting_start_time = time.time()
            self.current_agenda_index = 0
            self.decisions = []
            self.open_items = []
            self.called_attendee_ids = set()
            self.overtime_alerted = set()
            tools.extend(create_meeting_tools(self))
            if self.monitor_task and not self.monitor_task.done():
                self.monitor_task.cancel()
            self.monitor_task = asyncio.create_task(self._meeting_time_monitor())

        self.current_session = self.create_session(self.current_config)
        self.current_agent = PlaygroundAgent(
            instructions=self.current_config.instructions,
            tools=tools
        )

        await self.current_session.start(
            room=ctx.room,
            agent=self.current_agent,
        )

        # Initial state sync to web clients if meeting is active
        if self.current_config.meeting_config:
            await self.publish_meeting_data({
                "type": "state_sync",
                "state": {
                    "currentAgendaIndex": self.current_agenda_index,
                    "elapsedSeconds": self.get_elapsed_seconds(),
                    "decisions": self.decisions,
                    "openItems": self.open_items,
                    "calledAttendeeIds": [],
                    "driftWarning": False,
                }
            })

        # Register RPC methods BEFORE the opening announcement, so a participant
        # clicking "立即纠偏" / "推进议题" while the greeting is being spoken never
        # hits an unregistered method.

        # Register RPC method for config updates
        @ctx.room.local_participant.register_rpc_method("pg.updateConfig")
        async def update_config(data: rtc.rpc.RpcInvocationData):
            logger.info(f"update_config called by {data.caller_identity}: {data.payload}")
            if self.current_session is None or data.caller_identity != participant.identity:
                logger.info("update_config called by non-participant or no session")
                return json.dumps({"changed": False})

            new_config = parse_session_config(json.loads(data.payload))
            if self.current_config != new_config:
                logger.info(
                    f"config changed: {new_config.to_dict()}, participant: {participant.identity}"
                )
                old_config = self.current_config
                self.current_config = new_config
                await self.replace_session(ctx, participant, new_config, old_config)
                return json.dumps({"changed": True})
            else:
                logger.info("config not changed at all")
                return json.dumps({"changed": False})

        # Register RPC method for advancing agenda from frontend
        @ctx.room.local_participant.register_rpc_method("pg.advanceAgenda")
        async def advance_agenda_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.advanceAgenda called by {data.caller_identity}: {data.payload}")
            try:
                payload = json.loads(data.payload) if data.payload else {}
                item_index = payload.get("item_index", self.current_agenda_index + 2)
                target_idx = self.clamp_agenda_index(int(item_index))
                self.current_agenda_index = target_idx
                self.called_attendee_ids = set()
                await self.publish_meeting_data({
                    "type": "advance_agenda",
                    "currentAgendaIndex": target_idx,
                })
                return json.dumps({"success": True, "currentAgendaIndex": target_idx})
            except Exception as err:
                logger.error(f"Error handling advanceAgenda RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

        # Register RPC method for forcing moderator intervention
        @ctx.room.local_participant.register_rpc_method("pg.forceIntervene")
        async def force_intervene_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.forceIntervene called by {data.caller_identity}: {data.payload}")
            try:
                payload = json.loads(data.payload) if data.payload else {}
                reason = payload.get("reason", "讨论内容偏离当前议程核心目标")

                await self.publish_meeting_data({
                    "type": "drift_warning",
                    "active": True,
                    "reason": reason,
                })

                cfg = self.current_config.meeting_config or {}
                agendas = cfg.get("agendas", [])
                idx = self.current_agenda_index
                cur_title = agendas[idx].get("title", f"第 {idx + 1} 项议题") if 0 <= idx < len(agendas) else "当前议题"
                cur_goal = agendas[idx].get("goal", "") if 0 <= idx < len(agendas) else ""

                if self.current_session:
                    prompt = (
                        f"【主持人紧急强行切入叫停指令】：参会人员发言正在偏离议题。请立即用清脆、权威、响亮的声音开麦强行打断，"
                        f"第一句必须明确叫停：“打扰一下，请大家先暂停一下！” 紧接着说明：“我们当前正在进行的是议题【{cur_title}】，"
                        f"核心目标是【{cur_goal}】。刚才讨论已脱离本议题，请大家立刻收束，回到当前议题的核心讨论！”"
                        f"态度果断有力，绝对不可退缩！"
                    )
                    # Not awaited: the RPC must return before LiveKit's timeout,
                    # and the speech itself is scheduled by the session.
                    self.cue_model(prompt, allow_interruptions=False)

                return json.dumps({"success": True})
            except Exception as err:
                logger.error(f"Error handling forceIntervene RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

        # Greet the user (RPC endpoints are live by this point, so a participant
        # clicking 立即纠偏 during the opening announcement is served correctly)
        self.cue_model(
            OPENING_CUE_MEETING if self.current_config.meeting_config else OPENING_CUE_DEFAULT
        )

    async def send_image_to_frontend(self, prompt: str, image_data: bytes):
        if not self.ctx or not self.participant:
            logger.warning("Cannot send image: no context or participant")
            return

        try:
            writer = await self.ctx.room.local_participant.stream_bytes(
                name="generated_image.jpg",
                total_size=len(image_data),
                mime_type="image/jpeg",
                topic="nano_banana_image",
                destination_identities=[self.participant.identity],
                attributes={"prompt": prompt, "type": "nano_banana_image"},
            )

            await writer.write(image_data)
            await writer.aclose()

            logger.info(f"Image streamed to frontend, prompt: {prompt}")
        except Exception as e:
            logger.error(f"Failed to send image to frontend: {e}")

    @utils.log_exceptions(logger=logger)
    async def replace_session(self, ctx: JobContext, participant: rtc.RemoteParticipant, config: SessionConfig, old_config: SessionConfig):
        """Replace the current session with a new one using updated config"""
        if self.current_session is None or self.current_agent is None:
            return

        chat_ctx = None
        try:
            if hasattr(self.current_agent, 'chat_ctx'):
                chat_ctx = self.current_agent.chat_ctx
        except Exception as e:
            logger.warning(f"Could not preserve chat context: {e}")

        was_nano_banana_enabled = old_config.nano_banana_enabled
        is_nano_banana_enabled = config.nano_banana_enabled
        nano_banana_newly_enabled = not was_nano_banana_enabled and is_nano_banana_enabled

        logger.info(f"Nano Banana status: was={was_nano_banana_enabled}, now={is_nano_banana_enabled}, newly_enabled={nano_banana_newly_enabled}")

        await self.current_session.aclose()

        tools = []
        if config.nano_banana_enabled:
            tools.append(create_generate_image_tool(self))

        if config.meeting_config:
            tools.extend(create_meeting_tools(self))
            if not self.monitor_task or self.monitor_task.done():
                self.monitor_task = asyncio.create_task(self._meeting_time_monitor())
        elif self.monitor_task and not self.monitor_task.done():
            self.monitor_task.cancel()

        self.current_session = self.create_session(config)

        self.current_agent = PlaygroundAgent(
            instructions=config.instructions,
            tools=tools,
            chat_ctx=chat_ctx
        )

        await self.current_session.start(
            room=ctx.room,
            agent=self.current_agent,
        )

        # Best effort: on gemini-3.1 the replayed (text) history makes the model
        # answer the very first realtime *text* turn as text only, so this
        # announcement may stay silent there; normal audio turns are unaffected.
        try:
            if nano_banana_newly_enabled:
                logger.info("Nano Banana tool newly enabled")
                self.cue_model(
                    "Briefly and enthusiastically announce: 'Nano Banana now active, feel free to ask me to generate an image and I can show you whatever you like!'",
                )
            elif config.meeting_config and not old_config.meeting_config:
                logger.info("Meeting mode newly enabled")
                self.cue_model(
                    "Briefly announce that Meeting Moderator mode is now active with the configured agenda.",
                )
            else:
                logger.info("Session restarted with new config")
                self.cue_model(
                    is_nano_banana_enabled and "Briefly acknowledge that your configuration has been updated and you're ready to continue and announce that you can also generate images now!" or "Briefly acknowledge that your configuration has been updated and you're ready to continue"
                )
        except Exception as e:
            logger.error(f"Failed to notify user about config change: {e}")


if __name__ == "__main__":
    # Kept for backwards compatibility (`python main.py start|console`).
    # The built-in Python CLI is deprecated since livekit-agents 1.8: use
    # `lk agent dev` locally and `python -m livekit.agents start` in production.
    cli.run_app(server)
