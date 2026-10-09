from __future__ import annotations

import asyncio
import ctypes
import difflib
import functools
import json
import logging
import os
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass
from typing import Any, Dict, List

# The agent is a set of plain modules next to this file, not a package.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from dotenv import load_dotenv
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

from direct_voice import DirectVoice
from drift_detector import (
    REASON_LABELS,
    DriftDetector,
    DriftJudgment,
    DriftResult,
    JevJudge,
)
from fast_transcript import FastTranscript
from intervention import (
    INTERRUPTION_REASONS,
    Intervention,
    InterventionGate,
    InterventionSettings,
    spoken_interruption,
)
from meeting_limits import IDLE, LIMIT, End, LimitWatch, MeetingLimits, Notice
from model_caps import resolve_model
from phrasebook import (
    call_name,
    chair_name,
    spoken_decision,
    spoken_missing_elements,
    spoken_no_outcome,
    spoken_open_item,
    spoken_open_item_owner,
    spoken_open_item_without_owner,
    spoken_report_request,
    spoken_stance_request,
)
from phrasebook import spoken_summary as phrasebook_summary
from speech_gate import Answer, SpeechGate
from spoken_clips import SpokenClips

# Load .env.local from current directory or parent directory
load_dotenv(dotenv_path=".env.local")
load_dotenv(dotenv_path="../.env.local")

logger = logging.getLogger("gemini-playground")
logger.setLevel(logging.INFO)

# Suppress OpenTelemetry attribute warnings
logging.getLogger("opentelemetry.attributes").setLevel(logging.ERROR)
# one line per request, and the off-topic check makes a request every second
for _noisy in ("httpx", "httpx2", "httpcore", "typesafe_sdk"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)

#: Name the agent registers under. A developer running the agent locally sets
#: LIVEKIT_AGENT_NAME (in the agent and the web server) so their sessions are
#: not dispatched to the deployed agent that shares the LiveKit project.
AGENT_NAME = os.environ.get("LIVEKIT_AGENT_NAME", "").strip() or "gemini-playground"

#: Nobody gets interrupted automatically during the opening announcement.
OPENING_GRACE_SECONDS = 20.0
#: A semi-automatic suggestion stays on screen this long.
SUGGESTION_TTL_SECONDS = 20.0
#: If a cue produced no speech after this long, fall back once.
CUE_FALLBACK_SECONDS = 6.0
#: A Live session that "thinks" for this long is considered stuck.
DEAF_SECONDS = 30
STUCK_THINKING_SECONDS = 45.0
#: "speaking", but no audio has come from the model for this long
STUCK_SPEAKING_SECONDS = 20.0
#: Languages spoken in the meetings, as hints for the input transcription.
FAST_TRANSCRIPT_MODEL = "gemini-3.5-transcribe-live"
MEETING_LANGUAGE_CODES = ["cmn-Hans-CN", "en-US"]


def resolve_gemini_key(browser_key: str | None = None) -> str:
    """The Gemini key the agent uses: its own environment first.

    The key of the deployment never travels through the browser. A key typed
    into the UI only counts when the agent has none of its own.
    """
    return (
        os.environ.get("GEMINI_API_KEY", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "").strip()
        or (browser_key or "").strip()
    )


def redact_config_payload(payload: str) -> str:
    """Config payload for the log: no API key, no full prompt."""
    try:
        data = json.loads(payload)
    except Exception:
        return "<unparseable payload>"
    if not isinstance(data, dict):
        return "<unexpected payload>"
    shown = {}
    for key, value in data.items():
        if key == "gemini_api_key":
            shown[key] = "<set>" if value else "<empty>"
        elif key in ("instructions", "meeting_config"):
            shown[key] = f"<{len(str(value))} chars>"
        else:
            shown[key] = value
    return json.dumps(shown, ensure_ascii=False)


#: Without this the model paraphrases the sentence and keeps adding to it.
SAY_EXACTLY = (
    "只说下面引号里的话，照原话说，说完就停。"
    "不要加别的话，不要解释原因，不要复述本指令。语气谦和、平稳，语速正常，"
    "每个字都念出来，岗位名称不要缩略（「总经理」不要念成「总理」）。"
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
    meeting_config: dict | None = None

    def to_dict(self):
        return {k: v for k, v in asdict(self).items() if k != "gemini_api_key"}

    def session_fingerprint(self) -> dict:
        """What the Live session is built from.

        The intervention settings are left out: mode, threshold and cooldown
        are applied by code, so changing them must not restart the session.
        """
        data = self.to_dict()
        meeting = data.get("meeting_config")
        if isinstance(meeting, dict):
            data["meeting_config"] = {
                k: v for k, v in meeting.items() if k != "intervention"
            }
        return data

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
    meeting_config_raw = data.get("meeting_config")
    meeting_config = None
    if isinstance(meeting_config_raw, dict):
        meeting_config = meeting_config_raw
    elif isinstance(meeting_config_raw, str) and meeting_config_raw.strip():
        try:
            meeting_config = json.loads(meeting_config_raw)
        except Exception:
            meeting_config = None

    requested_model = data.get("model")
    model, _, replaced = resolve_model(requested_model)
    if replaced and requested_model:
        logger.warning(
            f"model '{requested_model}' is not supported any more, using '{model}'"
        )

    config = SessionConfig(
        gemini_api_key=data.get("gemini_api_key") or "",
        instructions=data.get("instructions", ""),
        model=model,
        voice=data.get("voice", "Puck"),
        temperature=float(data.get("temperature", 0.8)),
        max_response_output_tokens=
            "inf" if data.get("max_output_tokens") == "inf"
            else int(data.get("max_output_tokens") or 2048),
        modalities=SessionConfig._modalities_from_string(
            data.get("modalities", "audio_only")
        ),
        meeting_config=meeting_config,
    )
    return config


# Module-level AgentServer: `lk agent dev` and `python -m livekit.agents start`
# import this file and look for an AgentServer named `server`
# (see livekit.agents.cli.discover), so it has to live at module scope.
#
# LIVEKIT_AGENT_PORT pins the health-check port. In dev mode it is random by
# default, which tools that wait for a known port cannot work with.
_agent_port = os.environ.get("LIVEKIT_AGENT_PORT", "").strip()
server = AgentServer(port=int(_agent_port)) if _agent_port.isdigit() else AgentServer()


@server.rtc_session(agent_name=AGENT_NAME)
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
    if not resolve_gemini_key(config.gemini_api_key):
        logger.error(
            "no Gemini API key: set GEMINI_API_KEY in the agent's environment "
            "(.env.local locally, a secret on LiveKit Cloud)"
        )

    session_manager = SessionManager(config)
    ctx.add_shutdown_callback(session_manager.stop_detector)
    await session_manager.start_session(ctx, participant)

    @ctx.room.on("participant_disconnected")
    def _participant_left(p: rtc.RemoteParticipant):
        if p.identity == participant.identity:
            session_manager._spawn(session_manager.end_if_abandoned())

    logger.info("agent started")


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


def logged_tool(fn):
    """Logs every tool call of the model with its arguments and the answer.

    Without this nothing shows why the moderator did not move on: a refused
    ``advance_agenda`` looks the same as one that was never called.
    """

    @functools.wraps(fn)
    async def wrapper(raw_arguments: dict) -> str:
        result = await fn(raw_arguments)
        arguments = json.dumps(raw_arguments, ensure_ascii=False)
        logger.info(f"tool {fn.__name__}({arguments}) -> {result[:160]}")
        return result

    return wrapper


def squash(text: str | None) -> str:
    """Text with all whitespace removed, for comparing what the model wrote.

    The model hears "3 号注塑机" and writes "3号注塑机" (or the other way
    round). Compared as-is, a decision recorded under the second spelling did
    not count for the agenda item configured under the first, and the agenda
    could not be advanced although the decision was on the board.
    """
    return "".join((text or "").split())


def same_matter(a: str, b: str, threshold: float = 0.6) -> bool:
    """Whether two descriptions written by the model are about the same thing.

    The model never words a matter the same way twice, so this compares how
    much of the text the two have in common.
    """
    a, b = squash(a), squash(b)
    if not a or not b:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= threshold


def shared_characters(a: str, b: str) -> float:
    """How much of the shorter text's characters the other one has too.
    Unlike same_matter it does not care about the order of the words."""
    left = {c for c in squash(a) if c.isalnum()}
    right = {c for c in squash(b) if c.isalnum()}
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


#: a matter that comes up again within this time is the same matter
REPEATED_WITHIN_MS = 120_000


def same_open_item(issue: str, reason: str, known: dict, now_ms: int) -> bool:
    """Whether an open item is the one already on the board.

    The model records an item when it first hears "今天定不下来" and again
    when somebody proposes to record it, each time in its own words.
    """
    if same_matter(issue + reason, known.get("issue", "") + known.get("reason", "")):
        return True
    if same_matter(issue, known.get("issue", "")):
        return True
    recent = now_ms - known.get("updatedAt", known.get("timestamp", 0)) < REPEATED_WITHIN_MS
    return recent and shared_characters(issue, known.get("issue", "")) >= 0.5


def spoken_summary(decisions: list[dict], open_items: list[dict]) -> str:
    """The summary the chair asked for (wording in phrasebook.py)."""
    incomplete = len([d for d in decisions if missing_decision_fields(d)])
    return phrasebook_summary(decisions, open_items, incomplete)


def create_summarize_meeting_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "summarize_meeting",
        "description": (
            "会议小结：向全场报告已记录几条决议、还有几条未决事项。"
            "只在主持人或参会人明确要求你做总结时调用，不要因为议题谈完了就自己调用，也不要借此宣布散会。"
            "总结由系统宣布，你不要自己口头总结。"
        ),
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    @logged_tool
    async def summarize_meeting(raw_arguments: dict) -> str:
        if time.time() - session_manager.summarized_at < 60:
            return "总结刚才已经向全场宣布过，不要再宣布，保持静默。"
        session_manager.summarized_at = time.time()
        sentence = spoken_summary(session_manager.decisions, session_manager.open_items)
        await session_manager.publish_meeting_data({"type": "meeting_summary", "text": sentence})
        if session_manager.announce(sentence):
            # the sentence is not quoted: given the words, the model says them too
            return "系统会替你向全场宣布会议总结。你不要总结，也不要说别的，保持静默。"
        return f"{SAY_EXACTLY}\n“{sentence}”"

    return summarize_meeting


def create_get_meeting_timer_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "get_meeting_timer",
        "description": "获取当前会议的已用时长、剩余时长、总计划时间、当前议题，以及要素不全的决议清单。",
        "parameters": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    @logged_tool
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

        incomplete = session_manager.incomplete_decisions()
        if incomplete:
            details = "；".join(
                f"「{d.get('decision', '')[:20]}」缺 {'、'.join(m)}" for d, m in incomplete
            )
            parts.append(
                f"有 {len(incomplete)} 条决议要素不全：{details}。只在主持人问起时才告诉他，不要自己去追问。"
            )

        if not session_manager.decisions_for_current_agenda() and not session_manager.open_items_for_current_agenda():
            parts.append("当前议题还没有记录决议或未决事项。")

        return " ".join(parts)

    return get_meeting_timer


def create_advance_agenda_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "advance_agenda",
        "description": "记录会议已推进到下一项或指定项议程（序号从1开始），并在前台看板同步。只在主持人或参会人明确说要进入下一项后调用；是否进入下一项由主持人决定。",
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
    @logged_tool
    async def advance_agenda(raw_arguments: dict) -> str:
        session_manager.let_model_speak()
        try:
            item_index = int(raw_arguments.get("item_index", 1))
        except (ValueError, TypeError):
            item_index = 1
        summary = raw_arguments.get("summary", "")

        # The chair decides when to move on. When the item that is left has
        # neither a decision nor an open item, the assistant says so once.
        leaving_idx = session_manager.current_agenda_index
        target_idx = session_manager.clamp_agenda_index(item_index)
        left_without_outcome = (
            target_idx > leaving_idx
            and not session_manager.decisions_for_current_agenda()
            and not session_manager.open_items_for_current_agenda()
        )
        left_title = session_manager.current_agenda_title()

        agendas = session_manager.meeting_agendas()

        # The model calls this again when somebody speaks before it got to
        # announce the new item. The second call must not start the item over.
        if target_idx != leaving_idx:
            session_manager.current_agenda_index = target_idx
            session_manager.called_attendee_ids = set()
            session_manager.on_agenda_changed()

            await session_manager.publish_meeting_data({
                "type": "advance_agenda",
                "currentAgendaIndex": target_idx,
                "summary": summary,
            })

        in_range = 0 <= target_idx < len(agendas)
        title = agendas[target_idx].get("title", "") if in_range else ""
        minutes = agendas[target_idx].get("durationMinutes") if in_range else None
        note = ""
        if target_idx != item_index - 1:
            note = f"（请求的第 {item_index} 项超出议程范围，已定位到第 {target_idx + 1} 项）"
        if target_idx == leaving_idx:
            return (
                f"议程已经在第 {target_idx + 1} 项「{title}」，不需要再推进。"
                "已经宣布过就不要再宣布，继续听大家讨论。"
            )
        planned = f"，计划 {minutes} 分钟" if minutes else ""
        if left_without_outcome:
            reminder = spoken_no_outcome(
                session_manager.chair_call(), leaving_idx + 1, left_title
            )
            return (
                f"议程已更新至第 {target_idx + 1} 项{note}，看板已同步。"
                f"不需要宣布新议题。只提醒一次：{SAY_EXACTLY}\n“{reminder}”"
            )
        return (
            f"议程已更新至第 {target_idx + 1} 项「{title}」{planned}{note}，看板已同步。"
            "不需要口头宣布，也不要说别的，保持静默。"
        )

    return advance_agenda


def create_record_decision_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "record_decision",
        "description": (
            "记录会议中达成的明确决议或 Action Item，同步展示在前台看板和最终纪要中。"
            "公司要求每条决议必须带齐四要素：责任人、完成时限、验证方式、关闭证据。"
            "四要素只能填会上有人说出来的内容；没有人说过的要素留空，由你当场追问，不要自己编。"
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
    @logged_tool
    async def record_decision(raw_arguments: dict) -> str:
        session_manager.let_model_speak()
        decision_text = raw_arguments.get("decision", "")
        agenda_title = session_manager.canonical_agenda_title(
            raw_arguments.get("agenda_title"), fallback="通用决议"
        )

        # 补齐四要素时模型会带着同一条结论再调用一次：按「议题+结论文本」做 upsert，
        # 复用原 id 覆盖，避免看板上出现两条内容相同、完整度不同的决议。
        existing = next(
            (
                d
                for d in session_manager.decisions
                if d.get("agendaTitle") == agenda_title
                and squash(d.get("decision")) == squash(decision_text)
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

        session_manager.prepare_summary()
        missing = missing_decision_fields(decision_item)
        base = (
            f"已记录决议：【{decision_text}】（议题：{agenda_title}，"
            f"责任人：{decision_item['owner'] or '缺'}，"
            f"完成时限：{decision_item['dueDate'] or '缺'}，"
            f"验证方式：{decision_item['verification'] or '缺'}，"
            f"关闭证据：{decision_item['evidence'] or '缺'}），已同步至前台看板。"
        )
        if missing:
            question = spoken_missing_elements(missing, session_manager.chair_call())
            return (
                base
                + f" 但该决议仍缺少：{'、'.join(missing)}。"
                "向主持人请示着问一句，补齐后重新调用 record_decision 覆盖记录；"
                f"问过两轮仍问不齐，就改用 record_open_item 记为未决事项。{SAY_EXACTLY}\n“{question}”"
            )
        owner, due = decision_item["owner"], decision_item["dueDate"]
        readback = spoken_decision(decision_text, owner, due)
        return base + f" 四要素齐全。{SAY_EXACTLY}\n“{readback}”"

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
    @logged_tool
    async def record_open_item(raw_arguments: dict) -> str:
        issue = raw_arguments.get("issue", "")
        agenda_title = session_manager.canonical_agenda_title(
            raw_arguments.get("agenda_title")
        )
        escalate_to = raw_arguments.get("escalate_to") or session_manager.escalation_path()

        reason = raw_arguments.get("reason") or ""
        # The model records an item when it first hears "今天定不下来" and again
        # when somebody proposes to record it, in other words each time: the
        # second call updates the first instead of adding a twin.
        owner = raw_arguments.get("owner") or ""
        now_ms = int(time.time() * 1000)

        existing = next(
            (
                o
                for o in session_manager.open_items
                if o.get("agendaTitle") == agenda_title
                and same_open_item(issue, reason, o, now_ms)
            ),
            None,
        )
        open_item = {
            "id": existing["id"] if existing else f"open-{uuid.uuid4().hex[:8]}",
            "agendaTitle": agenda_title,
            "issue": issue,
            "reason": reason,
            "owner": owner or (existing or {}).get("owner", ""),
            "escalateTo": escalate_to,
            "timestamp": existing["timestamp"] if existing else now_ms,
            "updatedAt": now_ms,
            "announcedAt": (existing or {}).get("announcedAt", 0),
            "announcedOwner": (existing or {}).get("announcedOwner", ""),
        }
        if existing:
            session_manager.open_items[session_manager.open_items.index(existing)] = open_item
        else:
            session_manager.open_items.append(open_item)

        await session_manager.publish_meeting_data({
            "type": "new_open_item",
            "openItem": open_item,
        })

        recorded = (
            f"已登记未决事项：【{issue}】（议题：{agenda_title}，跟进人：{open_item['owner'] or '待定'}，"
            f"升级路径：{escalate_to}）。"
        )
        session_manager.prepare_summary()
        if not open_item["owner"]:
            # announced once somebody is named: "由相关责任人跟进" commits nobody
            return recorded + f"还没有跟进人。{SAY_EXACTLY}\n“{spoken_open_item_without_owner()}”"
        if open_item.get("announcedOwner") == open_item["owner"]:
            return recorded + "这一条已经向全场宣布过，不要再宣布，继续听大家讨论。"
        if session_manager.announce(session_manager.open_item_wording(open_item["id"])):
            return recorded + "系统会替你向全场宣布这一条。你不要宣布，也不要说别的，保持静默。"
        open_item["announcedOwner"] = open_item["owner"]
        sentence = spoken_open_item(open_item["owner"], escalate_to)
        return recorded + f"{SAY_EXACTLY}\n“{sentence}”"

    return record_open_item


def create_request_speaker_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "request_speaker",
        "description": (
            "请某位参会人发言。不要主动、逐个地点名：只在主持人或参会人明确要你替主持人问某人、"
            "或请某人介绍情况时才调用；沉默既不算同意也不算反对。"
            "report（介绍情况）：请某个人先介绍情况或说明看法，只点最相关的一两位。"
            "stance（征询意见）：议题有了结论或方案之后，应主持人要求征询某人的意见，前台看板会高亮被问到的人。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "attendee_names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "要点名的参会人姓名或岗位，须来自会议参会人名单；可以一次点多位",
                },
                "attendee_name": {
                    "type": "string",
                    "description": "只点一位时可用这个字段",
                },
                "purpose": {
                    "type": "string",
                    "enum": ["stance", "report"],
                    "description": "stance：对已有的结论或方案征询意见（默认）；report：请他先介绍情况、说明看法",
                },
                "reason": {
                    "type": "string",
                    "description": "征询的角度，只显示在看板上（如'从质量口径看是否接受该让步'）",
                },
            },
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    @logged_tool
    async def request_speaker(raw_arguments: dict) -> str:
        session_manager.let_model_speak()
        names = raw_arguments.get("attendee_names") or []
        if isinstance(names, str):
            names = [names]
        if raw_arguments.get("attendee_name"):
            names = [*names, raw_arguments["attendee_name"]]
        reason = raw_arguments.get("reason") or ""

        found: list[dict] = []
        unknown: list[str] = []
        for name in names:
            attendee = session_manager.find_attendee(str(name))
            if attendee is None:
                unknown.append(str(name))
            elif attendee not in found:
                found.append(attendee)

        if not found:
            roster = session_manager.meeting_attendees()
            known = "、".join(
                (a.get("name") or a.get("role") or "") for a in roster if (a.get("name") or a.get("role"))
            )
            return (
                f"参会人名单中没有找到「{'、'.join(unknown)}」。"
                + (f"当前名单为：{known}。请改用名单中的称呼点名。" if known else "本次会议尚未登记参会人名单，可直接口头点名。")
            )

        if raw_arguments.get("purpose") == "report":
            who = [call_name(a) for a in found[:2]]
            title = session_manager.current_agenda_title()
            return f"{SAY_EXACTLY}\n“{spoken_report_request(who, title)}”"

        # A stance is a stance on a conclusion. Asked in the middle of the
        # discussion ("请王部长表个态"), it cuts the discussion short.
        if session_manager.discussed_current_agenda() and not (
            session_manager.decisions_for_current_agenda()
            or session_manager.open_items_for_current_agenda()
        ):
            title = session_manager.current_agenda_title()
            return (
                f"议题「{title}」还没有结论：没有记录决议，也没有登记未决事项。"
                "现在不要征询意见，也不要开口，继续听大家讨论。"
            )

        # There is nothing to agree to before somebody has said something
        # about the item: asked for a stance then, people answer "对什么表态？"
        if not session_manager.discussed_current_agenda():
            title = session_manager.current_agenda_title()
            return (
                f"议题「{title}」还没有人发言，没有可以征询意见的内容。"
                "如果主持人要的是请人先介绍情况，再调用一次 request_speaker，purpose 填 report，"
                "attendee_names 只填与本议题最相关的一位。"
            )

        labels = []
        for attendee in found:
            label = call_name(attendee)
            labels.append(label)
            session_manager.called_attendee_ids.add(attendee.get("id", ""))
            await session_manager.publish_meeting_data({
                "type": "roll_call",
                "attendeeId": attendee.get("id", ""),
                "attendeeName": label,
                "reason": reason,
            })

        question = spoken_stance_request(labels)
        return (
            f"已在看板高亮 {'、'.join(labels)}。听完回答后继续监听，"
            f"不需要再去问别的人。{SAY_EXACTLY}\n“{question}”"
        )

    return request_speaker


def create_warn_topic_drift_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "warn_topic_drift",
        "description": "当参会人员的讨论明显偏离当前议题时，先调用本工具申请打断。工具会返回是否允许你开口：允许时照返回的原话说，不允许时保持静默。",
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
    @logged_tool
    async def warn_topic_drift(raw_arguments: dict) -> str:
        session_manager.let_model_speak()
        reason = raw_arguments.get("reason", "讨论内容偏离当前议程核心目标")
        return await session_manager.request_model_intervention(reason)

    return warn_topic_drift


def create_meeting_tools(session_manager: SessionManager):
    return [
        create_get_meeting_timer_tool(session_manager),
        create_advance_agenda_tool(session_manager),
        create_record_decision_tool(session_manager),
        create_record_open_item_tool(session_manager),
        create_request_speaker_tool(session_manager),
        create_warn_topic_drift_tool(session_manager),
        create_summarize_meeting_tool(session_manager),
    ]


class PlaygroundAgent(Agent):
    """Custom agent class for the playground"""
    def __init__(self, instructions: str, tools=None, chat_ctx=None):
        if chat_ctx:
            super().__init__(instructions=instructions, tools=tools or [], chat_ctx=chat_ctx)
        else:
            super().__init__(instructions=instructions, tools=tools or [])
        self.session_manager = None
        # with meeting tools it is the moderator of a meeting held in Chinese
        self.speech_gate = SpeechGate(
            on_dropped=self._on_placeholder_dropped, chinese=bool(tools)
        )

    def _on_placeholder_dropped(self, answer: Answer) -> None:
        logger.info(
            f"dropped {answer.dropped_seconds:.1f}s of sound that came with "
            f"a placeholder: {answer.text[:60]!r}"
        )

    def realtime_audio_output_node(self, audio, model_settings):
        return self.speech_gate.audio(audio)

    def transcription_node(self, text, model_settings):
        return Agent.default.transcription_node(
            self, self.speech_gate.text(text), model_settings
        )


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
        #: when the closing summary was last announced
        self.summarized_at = 0.0
        #: how much the room has said on the current item (characters)
        self.heard_chars_on_agenda = 0
        #: ends a meeting that was forgotten or runs far too long
        self.limit_watch: LimitWatch | None = None
        self.limit_task: asyncio.Task | None = None
        self.ended = False
        #: configs sent ahead of pg.updateConfig, by the key the browser chose
        self.received_configs: dict[str, tuple[str, str]] = {}
        self.config_arrived = asyncio.Event()
        self.overtime_alerted: set[int] = set()
        self.monitor_task: asyncio.Task | None = None

        # Off-topic handling: one gate shared by the Jev detector, the Live
        # model (warn_topic_drift) and the 立即纠偏 button.
        self.gate = InterventionGate(
            settings=InterventionSettings.from_dict(
                (config.meeting_config or {}).get("intervention")
            )
        )
        self.detector: DriftDetector | None = None
        self.fast_transcript: FastTranscript | None = None
        self.clips: SpokenClips | None = None
        self.voice: DirectVoice | None = None
        #: when the fast transcript heard something the Live model has not
        #: reported yet (monotonic), to notice a Live session that went deaf
        self.unheard_since: float | None = None
        self.last_suggestion: dict | None = None
        self.last_transcript_wall: float = 0.0
        self.agent_state_since: float = time.monotonic()
        self.last_watchdog_restart: float = 0.0
        self._background_tasks: set[asyncio.Task] = set()

    def get_elapsed_seconds(self) -> int:
        if self.meeting_start_time is None:
            return 0
        return int(time.time() - self.meeting_start_time)

    def _spawn(self, coro) -> asyncio.Task:
        """Run a coroutine from a sync event callback, keeping a reference."""
        task = asyncio.create_task(coro)
        self._background_tasks.add(task)
        task.add_done_callback(self._background_tasks.discard)
        return task

    # ---- ending the meeting -------------------------------------------------

    def start_limit_watch(self) -> None:
        planned = (self.current_config.meeting_config or {}).get("totalDurationMinutes")
        limits = MeetingLimits.for_meeting(planned)
        self.limit_watch = LimitWatch(limits, time.monotonic())
        logger.info(
            f"the meeting ends by itself after {limits.idle_seconds / 60:.0f} min of "
            f"silence or at {limits.max_seconds / 60:.0f} min"
        )
        if self.limit_task is None or self.limit_task.done():
            self.limit_task = asyncio.create_task(self._limit_monitor())

    def on_room_heard(self) -> None:
        watch = self.limit_watch
        if watch is not None and watch.heard(time.monotonic()):
            logger.info("somebody spoke: the meeting stays open")
            self._spawn(self.publish_meeting_data({"type": "meeting_ending", "active": False}))

    async def _limit_monitor(self) -> None:
        try:
            while not self.ended:
                await asyncio.sleep(5)
                watch = self.limit_watch
                if watch is None:
                    continue
                due = watch.check(time.monotonic())
                if isinstance(due, End):
                    await self.end_meeting(due.reason)
                    return
                if isinstance(due, Notice):
                    await self.announce_ending(due)
        except asyncio.CancelledError:
            pass

    async def announce_ending(self, notice: Notice) -> None:
        watch = self.limit_watch
        if watch is None:
            return
        if notice.reason == IDLE:
            minutes = round(watch.limits.idle_seconds / 60)
            sentence = (
                f"已经 {minutes} 分钟没有人发言。会议将在一分钟后自动结束，"
                "需要继续请直接发言。"
            )
        else:
            age = round((time.monotonic() - watch.started_at) / 60)
            left = max(round(notice.seconds_left / 60), 1)
            sentence = (
                f"会议已经开了 {age} 分钟，将在 {left} 分钟后自动结束。"
                "需要继续，请在看板上点「延长」。"
            )
        logger.info(f"ending announced ({notice.reason}): {sentence}")
        await self.publish_meeting_data({
            "type": "meeting_ending",
            "active": True,
            "reason": notice.reason,
            "secondsLeft": int(notice.seconds_left),
            "message": sentence,
        })
        self.cue_model(f"【系统通知】{SAY_EXACTLY}\n“{sentence}”")

    async def end_if_abandoned(self, grace: float = 20.0) -> None:
        """The browser left. A page that only lost its connection is back
        within seconds; one that was closed is not."""
        await asyncio.sleep(grace)
        if self.ctx is None or self.participant is None:
            return
        if self.participant.identity in self.ctx.room.remote_participants:
            return
        await self.end_meeting("participant_left")

    async def end_meeting(self, reason: str) -> None:
        """Stop everything that costs money: the Live session, the
        transcription, and the room itself."""
        if self.ended:
            return
        self.ended = True
        watch = self.limit_watch
        minutes = round((time.monotonic() - watch.started_at) / 60) if watch else 0
        idle_minutes = round(watch.limits.idle_seconds / 60) if watch else 10
        message = {
            IDLE: f"已有 {idle_minutes} 分钟无人发言，会议已自动结束。",
            LIMIT: f"会议已达到时长上限（{minutes} 分钟），已自动结束。",
        }.get(reason, "会议已结束。")
        logger.info(f"ending the meeting after {minutes} min ({reason})")
        await self.publish_meeting_data({
            "type": "meeting_ended",
            "reason": reason,
            "message": message,
        })
        # let the message reach the browser before the room goes away
        await asyncio.sleep(0.5)

        for task in (self.monitor_task, self.limit_task):
            if task and not task.done() and task is not asyncio.current_task():
                task.cancel()
        try:
            await self.stop_detector()
            if self.current_session is not None:
                await self.current_session.aclose()
        except Exception as e:
            logger.warning(f"closing the session failed: {e!r}")
        if self.ctx is not None:
            try:
                await self.ctx.delete_room()
            except Exception as e:
                logger.warning(f"deleting the room failed: {e!r}")
            self.ctx.shutdown(reason=f"meeting ended: {reason}")

    # ---- config updates -----------------------------------------------------

    async def receive_config(self, reader: rtc.TextStreamReader, identity: str) -> None:
        """Keep a config the browser sent as a text stream until the RPC asks
        for it. An RPC may carry 15 KB at most, the moderator prompt alone is
        about 13 KB, so the config travels as a stream and the RPC names it."""
        key = (reader.info.attributes or {}).get("key", "")
        text = await reader.read_all()
        if not key:
            return
        self.received_configs[key] = (identity, text)
        while len(self.received_configs) > 4:
            self.received_configs.pop(next(iter(self.received_configs)))
        self.config_arrived.set()

    async def take_config(self, key: str, identity: str, timeout: float = 5.0) -> str | None:
        deadline = time.time() + timeout
        while key not in self.received_configs:
            remaining = deadline - time.time()
            if remaining <= 0:
                return None
            self.config_arrived.clear()
            try:
                await asyncio.wait_for(self.config_arrived.wait(), remaining)
            except asyncio.TimeoutError:
                return None
        sender, text = self.received_configs.pop(key)
        return text if sender == identity else None

    # ---- off-topic handling ----------------------------------------------

    def discussed_current_agenda(self) -> bool:
        """Whether the room has said anything of substance on this item."""
        return self.heard_chars_on_agenda >= 30

    def on_agenda_changed(self) -> None:
        """A new agenda item starts from a clean slate."""
        self.heard_chars_on_agenda = 0
        self.gate.hold()
        if self.detector is not None:
            self.detector.reset()
        self.prepare_interruption_clips()

    def prepare_interruption_clips(self) -> None:
        """Has every interruption for the current agenda item ready to play."""
        if not self.current_config.meeting_config:
            return
        if os.environ.get("SPOKEN_CLIPS", "1") == "0":
            return
        key = resolve_gemini_key(self.current_config.gemini_api_key)
        if not key:
            return
        if self.clips is None:
            self.clips = SpokenClips(key, self.current_config.voice)
        if self.voice is None and self.ctx is not None:
            self.voice = DirectVoice(self.ctx.room)
        scripts = [self.interruption_script(code) for code in ("", *INTERRUPTION_REASONS)]
        self.clips.prepare(scripts)
        self.prepare_announcements()
        self._spawn(self._warm_up_voice(scripts[0]))

    async def _warm_up_voice(self, script: str) -> None:
        for _ in range(200):
            clip = self.clips.get(script) if self.clips is not None else None
            if clip is not None and self.voice is not None:
                await self.voice.warm_up(clip)
                return
            await asyncio.sleep(0.1)

    def speak_interruption(self, intervention: Intervention):
        """Interrupts now. Returns a handle the undo can stop, or None when
        the Live model was asked to say it (and answers at the next pause)."""
        script = self.interruption_script(intervention.reason_code)
        clip = self.clips.get(script) if self.clips is not None else None
        if clip is not None and self.voice is not None:

            def started() -> None:
                intervention.speech_started_at = time.time()
                self._spawn(self.publish_intervention_metrics(intervention))
                self._spawn(self._tell_model_what_was_said(script))

            speech = self.voice.play(clip, script, on_started=started)
            if speech is not None:
                return speech
        return self.cue_model(self.intervention_prompt(intervention.reason_code))

    def let_model_speak(self) -> None:
        """The model is about to be given a sentence to say: what it says
        next is for the room, even right after an announcement."""
        gate = getattr(self.current_agent, "speech_gate", None)
        if gate is not None:
            gate.keep_next()

    def announce(self, wording) -> bool:
        """Says a sentence in the prepared voice instead of leaving it to the
        Live model, which does not always say what it is given: asked for
        "提请总经理签批", it was heard saying 总理. False when there is no
        prepared voice: the Live model has to say it then.

        `wording` is the sentence, or a function that returns it (or None for
        "nothing to say any more"). It is asked at the moment of speaking:
        what was recorded may have been corrected while the room was talking.
        """
        if self.clips is None or self.voice is None:
            return False
        gate = getattr(self.current_agent, "speech_gate", None)
        if gate is not None:
            # whatever the model answers to the tool is not for the room
            gate.drop_next()
        self._spawn(self._announce(wording))
        return True

    async def _announce(self, wording) -> None:
        await self.wait_for_pause()
        sentence = wording() if callable(wording) else wording
        if not sentence:
            return
        clip = await self.clips.wait(sentence, 8.0) if self.clips is not None else None
        session = self.current_session
        if clip is not None and session is not None:
            try:
                # Through the session, not on the track of the interruptions:
                # an announcement waits its turn. Played on a track of its own
                # it came out on top of what the Live model was saying.
                session.say(sentence, audio=clip.frames())
                return
            except Exception as e:
                logger.warning(f"could not announce in the prepared voice: {e!r}")
        self.cue_model(f"【系统通知】{SAY_EXACTLY}\n“{sentence}”")

    async def wait_for_pause(self, quiet: float = 1.0, patience: float = 12.0) -> None:
        """An announcement is not an interruption: it waits until the room
        has stopped talking, but not for ever."""
        started = time.monotonic()
        while time.monotonic() - started < patience:
            session = self.current_session
            talking = session is not None and session.user_state == "speaking"
            heard_ago = time.time() - self.last_transcript_wall
            if not talking and heard_ago >= quiet and not self.agent_is_speaking():
                return
            await asyncio.sleep(0.1)

    def prepare_summary(self) -> None:
        """Has the closing summary ready for the board as it is now, so that
        nobody waits for it to be synthesised when it is asked for."""
        if self.clips is not None:
            self.clips.prepare([spoken_summary(self.decisions, self.open_items)])

    def prepare_announcements(self) -> None:
        """The sentences that can be known before the meeting starts."""
        if self.clips is None:
            return
        path = self.escalation_path()
        names = [a.get("name") or a.get("role") or "" for a in self.meeting_attendees()]
        self.clips.prepare([spoken_open_item(name, path) for name in names if name])
        self.clips.prepare([spoken_open_item_owner(name) for name in names if name])

    def open_item_wording(self, item_id: str):
        """What there is to announce about an open item, asked when the
        moderator gets to speak."""

        def wording() -> str | None:
            item = next((o for o in self.open_items if o.get("id") == item_id), None)
            if item is None or not item.get("owner"):
                return None
            said = item.get("announcedOwner")
            if said == item["owner"]:
                return None
            item["announcedOwner"] = item["owner"]
            item["announcedAt"] = int(time.time() * 1000)
            if said:
                return spoken_open_item_owner(item["owner"])
            return spoken_open_item(item["owner"], item.get("escalateTo", ""))

        return wording

    async def _tell_model_what_was_said(self, script: str) -> None:
        """The Live model did not say the sentence and would not know about it."""
        rt = self._realtime_session()
        if rt is None:
            return
        try:
            chat_ctx = rt.chat_ctx.copy()
            chat_ctx.add_message(
                role="user",
                content=(
                    f"【系统提示】会议助手刚才已经提醒了跑题的发言，说的是：“{script}”"
                    "不要重复这句话，不要再调用 warn_topic_drift，继续监听。"
                ),
            )
            await rt.update_chat_ctx(chat_ctx)
        except Exception as e:
            logger.warning(f"could not tell the model about the interruption: {e!r}")

    def agent_is_speaking(self) -> bool:
        """Speaking, or about to: "thinking" is the model preparing its turn."""
        if self.voice is not None and self.voice.playing:
            return True
        session = self.current_session
        return session is not None and session.agent_state in ("speaking", "thinking")

    def drift_context(self) -> dict | None:
        """What Jev needs to know about the meeting. Kept small on purpose:
        its accuracy drops as the state fills up with unrelated content."""
        cfg = self.current_config.meeting_config
        if not cfg:
            return None
        agendas = self.meeting_agendas()
        idx = self.current_agenda_index
        if not 0 <= idx < len(agendas):
            return None
        current = agendas[idx]
        return {
            "meeting_topic": cfg.get("topic", ""),
            "current_agenda": {
                "title": current.get("title", ""),
                "goal": current.get("goal", ""),
            },
            "other_agenda_titles": [
                a.get("title", "") for i, a in enumerate(agendas) if i != idx
            ],
        }

    def interruption_script(self, reason_code: str = "") -> str:
        """The exact words of an interruption, for the current agenda item."""
        agendas = self.meeting_agendas()
        idx = self.current_agenda_index
        title = agendas[idx].get("title", "") if 0 <= idx < len(agendas) else ""
        style = (self.current_config.meeting_config or {}).get("style", "strict")
        return spoken_interruption(title, reason_code, style, self.chair_call())

    def intervention_prompt(self, reason_code: str = "") -> str:
        return (
            "【打断指令】讨论已经跑题，请你现在开口打断。"
            f"{SAY_EXACTLY}不要调用 warn_topic_drift。\n"
            f"“{self.interruption_script(reason_code)}”"
        )

    def move_on_prompt(self) -> str | None:
        """What to tell the model when people talk about another agenda item
        although the current one already has its outcome. None if it has not."""
        if not (self.decisions_for_current_agenda() or self.open_items_for_current_agenda()):
            return None
        title = self.current_agenda_title()
        return (
            f"【推进指令】议题「{title}」已有结论，大家已经谈到别的议题。"
            "请判断大家在谈议程里的哪一项，调用 advance_agenda 记录推进到那一项。"
            "不需要口头宣布。不要调用 warn_topic_drift。"
        )

    async def publish_drift_warning(self, intervention: Intervention) -> None:
        intervention.published_at = time.time()
        latency_ms = None
        if intervention.transcript_at:
            latency_ms = int((intervention.published_at - intervention.transcript_at) * 1000)
        await self.publish_meeting_data({
            "type": "drift_warning",
            "active": True,
            "source": intervention.source,
            "interventionId": intervention.id,
            "reason": intervention.reason,
            "reasonCode": intervention.reason_code,
            "confidence": intervention.confidence,
            "latencyMs": latency_ms,
        })

    async def publish_drift_suggestion(
        self, *, source: str, reason: str, reason_code: str, confidence: float | None
    ) -> bool:
        suggestion_id = self.gate.try_suggest(SUGGESTION_TTL_SECONDS)
        if suggestion_id is None:
            return False
        self.last_suggestion = {
            "suggestionId": suggestion_id,
            "source": source,
            "reason": reason,
            "reasonCode": reason_code,
            "confidence": confidence,
        }
        await self.publish_meeting_data({
            "type": "drift_suggestion",
            **self.last_suggestion,
            "expiresAt": int((time.time() + SUGGESTION_TTL_SECONDS) * 1000),
        })
        return True

    async def request_model_intervention(self, reason: str) -> str:
        """The Live model thinks the discussion drifted and asks to cut in.

        The answer tells it whether to speak. Mode and cooldown are decided
        here, not in the prompt, so they can change while the meeting runs.
        """
        keep_quiet = "请保持静默，不要开口，不要向参会人提及本次检测，继续监听。"

        if self.gate.settings.mode == "semi_auto":
            await self.publish_drift_suggestion(
                source="model", reason=reason, reason_code="", confidence=None
            )
            return f"当前为提示主持人的模式：已在看板上提示主持人，由主持人决定是否请你开口。{keep_quiet}"

        intervention = self.gate.try_acquire("model")
        if intervention is None:
            logger.info("warn_topic_drift refused: cooling down")
            return f"刚刚已经提醒过一次，现在处于冷却期。{keep_quiet}"

        intervention.reason = reason
        intervention.transcript_at = self.last_transcript_wall or None
        if self.current_session is not None:
            # the model's own turn is the speech that delivers this interruption
            intervention.handle = self.current_session.current_speech
        if self.detector is not None:
            self.detector.reset()
        await self.publish_drift_warning(intervention)

        return (
            "允许打断，看板已显示跑题提示。请你现在开口。"
            f"{SAY_EXACTLY}\n“{self.interruption_script()}”"
        )

    async def handle_drift(self, result: DriftResult) -> None:
        """Jev judged the recent discussion off topic."""
        judgment = result.judgment
        logger.info(
            f"drift detected: p={judgment.probability:.2f} level={judgment.level:.2f} "
            f"reason={judgment.reason_code} jev={judgment.elapsed_ms}ms hits={result.hits}"
        )

        if self.gate.settings.mode == "semi_auto":
            await self.publish_drift_suggestion(
                source="jev",
                reason=result.reason,
                reason_code=judgment.reason_code,
                confidence=judgment.probability,
            )
            return

        move_on = (
            self.move_on_prompt() if judgment.reason_code == "other_agenda_item" else None
        )

        intervention = self.gate.try_acquire("jev", agent_speaking=self.agent_is_speaking())
        if intervention is None:
            logger.info("jev interruption refused: cooling down or moderator speaking")
            return

        if move_on:
            # Not a digression: the item is settled and the meeting moved on by
            # itself. Pulling people back to a finished item would be wrong.
            logger.info("the discussion moved to another agenda item; prompting to move on")
            self.gate.active = None
            if self.detector is not None:
                self.detector.reset()
            self.cue_model(move_on)
            return

        intervention.confidence = judgment.probability
        intervention.reason = result.reason
        intervention.reason_code = judgment.reason_code
        intervention.excerpt = result.excerpt
        intervention.transcript_at = result.transcript_at
        intervention.jev_ms = judgment.elapsed_ms

        await self.publish_drift_warning(intervention)
        intervention.handle = self.speak_interruption(intervention)

    async def handle_judgment(self, judgment: DriftJudgment) -> None:
        """Every judgment feeds the live confidence meter on the kanban."""
        await self.publish_meeting_data({
            "type": "drift_score",
            "confidence": judgment.probability,
            "level": judgment.level,
            "reasonCode": judgment.reason_code,
            "reason": REASON_LABELS.get(judgment.reason_code, ""),
            "jevMs": judgment.elapsed_ms,
            "threshold": self.gate.settings.threshold,
        })

    def start_detector(self) -> None:
        if self.detector is not None or not self.current_config.meeting_config:
            return
        judge = JevJudge.from_env()
        if judge is None:
            logger.warning(
                "JEV_API_KEY is not set: off-topic detection relies on the Live model alone"
            )
            return
        self.detector = DriftDetector(
            judge,
            get_context=self.drift_context,
            get_settings=lambda: self.gate.settings,
            on_drift=self.handle_drift,
            on_judgment=self.handle_judgment,
        )
        # Open the connection now so the first real judgment does not pay for
        # the TLS handshake (about 1.5 s through a proxy).
        self._spawn(self._warm_up_detector(judge))
        logger.info("Jev drift detector started")
        self.start_fast_transcript()
        self.prepare_interruption_clips()

    def meeting_vocabulary(self) -> list[str]:
        """Names and titles of this meeting, to bias the speech recognition."""
        words = [a.get("name", "") for a in self.meeting_attendees()]
        words += [a.get("title", "") for a in self.meeting_agendas()]
        return [w.strip() for w in words if w and w.strip()]

    def start_fast_transcript(self) -> None:
        if self.fast_transcript is not None or os.environ.get("FAST_TRANSCRIPT", "1") == "0":
            return
        if self.ctx is None or self.participant is None:
            return
        key = resolve_gemini_key(self.current_config.gemini_api_key)
        if not key:
            return
        self.fast_transcript = FastTranscript(
            self.ctx.room,
            self.participant.identity,
            self.on_fast_transcript,
            api_key=key,
            model=os.environ.get("GEMINI_TRANSCRIBE_MODEL", "").strip() or FAST_TRANSCRIPT_MODEL,
            language_codes=MEETING_LANGUAGE_CODES,
            vocabulary=self.meeting_vocabulary(),
        )
        self.fast_transcript.start()

    def on_fast_transcript(self, item_id: str, text: str, final: bool) -> None:
        self.last_transcript_wall = time.time()
        self.on_room_heard()
        if final:
            self.heard_chars_on_agenda += len(squash(text))
        # somebody finished a sentence: the Live model reports it within a
        # few seconds, unless it has gone deaf
        if final and self.unheard_since is None and len(text) >= 10:
            self.unheard_since = time.monotonic()
        if self.detector is not None:
            self.detector.on_transcript(item_id, text)

    async def _warm_up_detector(self, judge: JevJudge) -> None:
        context = self.drift_context()
        if not context:
            return
        try:
            judgment = await judge.judge({**context, "recent_transcript": "会议现在开始。"})
            logger.info(f"Jev connection warmed up in {judgment.elapsed_ms}ms")
        except Exception as e:
            logger.warning(f"Jev warm-up failed: {e!r}")

    async def stop_detector(self) -> None:
        fast, self.fast_transcript = self.fast_transcript, None
        if fast is not None:
            await fast.aclose()
        clips, self.clips = self.clips, None
        if clips is not None:
            await clips.aclose()
        voice, self.voice = self.voice, None
        if voice is not None:
            await voice.aclose()
        detector, self.detector = self.detector, None
        if detector is not None:
            await detector.aclose()

    def attach_session_events(self, session: AgentSession) -> None:
        @session.on("user_input_transcribed")
        def _on_user_input_transcribed(ev) -> None:
            if not ev.transcript:
                return
            if ev.is_final:
                self.heard_chars_on_agenda += len(squash(ev.transcript))
            self.unheard_since = None
            self.on_room_heard()
            fast = self.fast_transcript
            if fast is not None and fast.healthy:
                # the detection already heard this, seconds ago
                return
            self.last_transcript_wall = time.time()
            if self.detector is not None:
                self.detector.on_transcript(ev.item_id, ev.transcript)

        @session.on("agent_state_changed")
        def _on_agent_state_changed(ev) -> None:
            self.agent_state_since = time.monotonic()
            if ev.new_state != "speaking":
                return
            intervention = self.gate.active
            if (
                intervention is None
                or intervention.undone
                or intervention.speech_started_at is not None
                or time.time() - (intervention.published_at or 0) > 15
            ):
                return
            intervention.speech_started_at = time.time()
            self._spawn(self.publish_intervention_metrics(intervention))

        @session.on("speech_created")
        def _on_speech_created(ev) -> None:
            intervention = self.gate.active
            if intervention is not None and intervention.pending_cancel:
                intervention.pending_cancel = False
                ev.speech_handle.interrupt(force=True)

    async def publish_intervention_metrics(self, intervention: Intervention) -> None:
        def since_transcript(moment: float | None) -> int | None:
            if not moment or not intervention.transcript_at:
                return None
            return int((moment - intervention.transcript_at) * 1000)

        metrics = {
            "type": "intervention_metrics",
            "interventionId": intervention.id,
            "source": intervention.source,
            "jevMs": intervention.jev_ms,
            "detectToPublishMs": since_transcript(intervention.published_at),
            "speechStartMs": since_transcript(intervention.speech_started_at),
        }
        logger.info(f"intervention latency: {metrics}")
        await self.publish_meeting_data(metrics)

    async def publish_intervention_settings(self) -> None:
        await self.publish_meeting_data({
            "type": "intervention_settings",
            "intervention": self.gate.settings.to_dict(),
        })

    async def silence_intervention(self, intervention: Intervention) -> None:
        """Stop the moderator's interruption and let the speaker carry on.

        The Live session runs with NO_INTERRUPTION, so the server finishes
        generating its turn whatever we do; what can be stopped is the playback.
        ``force`` is needed for the same reason. The browser mutes the agent
        track at the same moment, in case the speech has not reached us yet.
        """
        session = self.current_session
        handles = [intervention.handle]
        if session is not None:
            # When the model interrupted on its own, the speech that is playing
            # is its reply to the tool result, not the turn that made the call.
            handles.append(session.current_speech)

        stopped = False
        for handle in handles:
            if handle is not None and not handle.done():
                handle.interrupt(force=True)
                stopped = True
        if not stopped:
            # the speech does not exist yet: cancel it as soon as it is created
            intervention.pending_cancel = True

        rt = self._realtime_session()
        if rt is None:
            return
        try:
            chat_ctx = rt.chat_ctx.copy()
            chat_ctx.add_message(
                role="user",
                content=(
                    "【系统提示】主持人撤销了你刚才的提醒：那段讨论并没有跑题，是你判断有误。"
                    "请保持静默，让发言人继续，不要道歉也不要解释；之后对同类内容放宽判断。"
                ),
            )
            await rt.update_chat_ctx(chat_ctx)
        except Exception as e:
            # best effort: the playback is already stopped
            logger.warning(f"could not tell the model about the undo: {e!r}")

    # ---- meeting helpers -------------------------------------------------

    def meeting_agendas(self) -> list[dict]:
        cfg = self.current_config.meeting_config or {}
        agendas = cfg.get("agendas", [])
        return agendas if isinstance(agendas, list) else []

    def meeting_attendees(self) -> list[dict]:
        cfg = self.current_config.meeting_config or {}
        attendees = cfg.get("attendees", [])
        return attendees if isinstance(attendees, list) else []

    def chair_call(self) -> str:
        """How the assistant addresses the chair ("李总"; else the role)."""
        return chair_name(self.current_config.meeting_config)

    def escalation_path(self) -> str:
        cfg = self.current_config.meeting_config or {}
        return cfg.get("escalationPath") or "提请总经理签批并留档"

    def current_agenda_title(self) -> str:
        agendas = self.meeting_agendas()
        idx = self.current_agenda_index
        if 0 <= idx < len(agendas):
            return agendas[idx].get("title", f"议题 {idx + 1}")
        return "当前议题"

    def canonical_agenda_title(self, title: str | None, fallback: str = "") -> str:
        """The configured spelling of an agenda title the model passed in.

        Nothing passed in means the current agenda item. A title that matches
        no configured item is kept as the model wrote it.
        """
        agendas = self.meeting_agendas()
        if not (title or "").strip():
            idx = self.current_agenda_index
            if 0 <= idx < len(agendas):
                return agendas[idx].get("title", "") or fallback
            return fallback or "当前议题"

        wanted = squash(title)
        for agenda in agendas:
            if squash(agenda.get("title")) == wanted:
                return agenda.get("title", "")
        return title.strip()

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

    def incomplete_decisions(self) -> list[tuple[dict, list[str]]]:
        """Decisions missing any of the four mandatory elements."""
        out: list[tuple[dict, list[str]]] = []
        for d in self.decisions:
            missing = missing_decision_fields(d)
            if missing:
                out.append((d, missing))
        return out

    def decisions_for_current_agenda(self) -> list[dict]:
        title = squash(self.current_agenda_title())
        return [d for d in self.decisions if squash(d.get("agendaTitle")) == title]

    def open_items_for_current_agenda(self) -> list[dict]:
        title = squash(self.current_agenda_title())
        return [o for o in self.open_items if squash(o.get("agendaTitle")) == title]

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

                await self._restart_if_stuck()

                # Check agenda overtime alert
                if 0 <= idx < len(agendas) and idx not in self.overtime_alerted:
                    accumulated_target_secs = sum(a.get("durationMinutes", 0) for a in agendas[:idx+1]) * 60
                    if elapsed > accumulated_target_secs:
                        self.overtime_alerted.add(idx)
                        cur_title = agendas[idx].get("title", f"议题 {idx + 1}")
                        logger.info(f"Agenda {idx + 1} ({cur_title}) has exceeded planned time")

                        # Running over time is not going off topic: it has its
                        # own message so the UI does not show a drift warning.
                        await self.publish_meeting_data({
                            "type": "overtime_warning",
                            "agendaIndex": idx,
                            "title": cur_title,
                            "reason": f"议题「{cur_title}」已达到计划用时，建议尽快确认决议并推进至下一议题。"
                        })
        except asyncio.CancelledError:
            logger.info("Meeting time monitor cancelled")
        except Exception as e:
            logger.error(f"Error in meeting time monitor: {e}")

    async def _restart_if_stuck(self) -> None:
        """Replace a Live session that stopped responding.

        Seen once in testing: after a chain of tool calls the session stayed in
        "thinking" and delivered neither speech nor transcripts any more, which
        also blinds the off-topic detection. A moderator that went deaf in the
        middle of a meeting is worse than a short gap, so after
        STUCK_THINKING_SECONDS the session is rebuilt with the same settings.
        The meeting state (agenda, decisions, open items) lives in this object
        and carries over.
        """
        session = self.current_session
        if session is None or self.ctx is None or self.participant is None:
            return
        now = time.monotonic()
        stuck = (
            session.agent_state == "thinking"
            and now - self.agent_state_since >= STUCK_THINKING_SECONDS
        )
        # Or it hangs in "speaking" with nothing left to say. Seen once: the
        # answer never ended, and for five minutes the moderator neither heard
        # a request nor let the off-topic detection interrupt.
        gate = getattr(self.current_agent, "speech_gate", None)
        last_audio = gate.last_audio_at if gate is not None else 0.0
        voiceless = (
            session.agent_state == "speaking"
            and now - max(self.agent_state_since, last_audio) >= STUCK_SPEAKING_SECONDS
            and not (self.voice is not None and self.voice.playing)
        )
        stuck = stuck or voiceless
        # The other way of failing: the session looks fine ("listening") but
        # reports nothing of what is being said, while the fast transcript
        # hears people talk.
        # Somebody who talks without a pause is no sign of it: the Live model
        # reports a remark when it is over.
        deaf = (
            self.unheard_since is not None
            and now - self.unheard_since >= DEAF_SECONDS
            and session.agent_state != "speaking"
            and session.user_state != "speaking"
        )
        if not (stuck or deaf):
            return
        if now - self.last_watchdog_restart < 2 * STUCK_THINKING_SECONDS:
            return

        self.last_watchdog_restart = now
        self.agent_state_since = now
        self.unheard_since = None
        logger.warning(
            "the Live session "
            + (
                f"has been '{session.agent_state}' without a sound for too long"
                if stuck
                else f"has not reported any speech for {DEAF_SECONDS:.0f}s while people talk"
            )
            + "; restarting it"
        )
        config = self.current_config
        await self.replace_session(self.ctx, self.participant, config, config)

    # ---- making the moderator speak on demand -----------------------------

    def _realtime_session(self) -> llm.RealtimeSession | None:
        if self.current_agent is None:
            return None
        try:
            return self.current_agent.realtime_llm_session
        except RuntimeError:
            # the agent is not running (yet, or any more)
            return None

    def cue_model(self, text: str):
        """Make the model speak now (opening announcement, forced intervention…).

        Two mechanisms exist, and ``model_caps`` says which one a model gets:

        * realtime text input: the cue is sent like something a participant
          typed, and the model answers it like a spoken turn. The reply comes
          through the normal generation path, so it is played (and can be
          stopped) like any other turn of the moderator. The plugin has no
          public entry point for this, hence the guarded access to its
          client-event channel.
        * ``AgentSession.generate_reply``: waits in the framework's speech queue
          and returns a SpeechHandle.

        Whichever is used first, the other one is tried once if the moderator is
        not audible after CUE_FALLBACK_SECONDS.

        Returns the SpeechHandle when there is one, else None.
        Never raises; failures are logged.
        """
        session = self.current_session
        if session is None:
            logger.warning("cue_model called without an active session")
            return None

        _, caps, _ = resolve_model(self.current_config.model)
        if caps.cue_strategy == "realtime_text" and self._cue_as_realtime_text(text):
            self._spawn(self._watch_cue(session, None, text))
            return None

        handle = self._cue_with_generate_reply(session, text)
        if handle is None:
            self._cue_as_realtime_text(text)
        else:
            self._spawn(self._watch_cue(session, handle, text))
        return handle

    def _cue_with_generate_reply(self, session: AgentSession, text: str):
        try:
            return session.generate_reply(instructions=text)
        except RuntimeError as e:
            logger.error(f"generate_reply failed: {e}")
            return None

    async def _watch_cue(self, session: AgentSession, handle, text: str) -> None:
        """Fall back to the other mechanism if the cue stays unanswered.

        The model answers at the next pause of whoever is speaking, so the
        clock only runs while the room is quiet: a cue is not "unanswered"
        because somebody kept talking, and sending it twice makes the
        moderator say it twice.
        """
        waited = 0.0
        started = time.monotonic()
        while waited < CUE_FALLBACK_SECONDS and time.monotonic() - started < 30:
            if session is not self.current_session:
                return
            if session.agent_state == "speaking":
                return
            if handle is not None and handle.done():
                if handle.interrupted or handle.exception() is None:
                    return
                break
            await asyncio.sleep(0.1)
            waited = 0.0 if session.user_state == "speaking" else waited + 0.1

        intervention = self.gate.active
        if intervention is not None and intervention.undone:
            return  # 撤销打断 arrived in the meantime: stay silent

        if handle is None:
            logger.warning("realtime text cue was not answered; trying generate_reply")
            fallback = self._cue_with_generate_reply(session, text)
            if intervention is not None and fallback is not None:
                intervention.handle = fallback
        else:
            logger.warning("generate_reply produced no speech; resending as realtime text")
            self._cue_as_realtime_text(text)

    def _cue_as_realtime_text(self, text: str) -> bool:
        rt = self._realtime_session()
        send = getattr(rt, "_send_client_event", None) if rt is not None else None
        if send is None:
            logger.error("no realtime text channel available; the cue is dropped")
            return False
        send(types.LiveClientRealtimeInput(text=text))
        return True

    def create_session(self, config: SessionConfig) -> AgentSession:
        """Create an AgentSession with the given configuration"""
        is_meeting = bool(config.meeting_config)
        model, caps, _ = resolve_model(config.model)
        llm_kwargs = {
            "model": model,
            "voice": config.voice,
            "max_output_tokens": int(config.max_response_output_tokens) if config.max_response_output_tokens != "inf" else None,
            # audio-only models reject a TEXT response modality; their text
            # comes from the output transcription
            "modalities": ["AUDIO"] if caps.audio_only else config.modalities,
            # the plugin only looks at GOOGLE_API_KEY, so the key is passed in
            "api_key": resolve_gemini_key(config.gemini_api_key),
            # Without context-window compression an audio-only Live session is
            # capped at 15 minutes; a 60-minute meeting needs the sliding window.
            # (Connection lifetime is still ~10 min: the plugin reconnects on
            # GoAway with the session-resumption handle it already requests.)
            "context_window_compression": types.ContextWindowCompressionConfig(
                sliding_window=types.SlidingWindow()
            ),
        }

        if caps.send_temperature:
            llm_kwargs["temperature"] = config.temperature
        if caps.tool_behavior is not None:
            llm_kwargs["tool_behavior"] = types.Behavior[caps.tool_behavior]

        session_kwargs = {}

        if is_meeting:
            logger.info(
                f"Enabling Meeting Moderator audio parameters for '{model}': "
                f"tool_behavior={caps.tool_behavior}, silence_duration_ms=250, NO_INTERRUPTION"
            )
            # No supported model takes the flag today (see model_caps): on 3.8
            # proactive audio is always on, and passing it anyway moves the
            # plugin onto the v1alpha API.
            if caps.supports_proactivity_flag:
                llm_kwargs["proactivity"] = True
            # Meetings are held in Mandarin with English terms mixed in. Told
            # so, the recognizer gets shop-floor vocabulary right that it
            # otherwise mishears (measured: "模温" came out as "磨损" without
            # the hint, correctly with it). The transcript feeds the off-topic
            # detection and the minutes, so its quality matters twice.
            llm_kwargs["input_audio_transcription"] = types.AudioTranscriptionConfig(
                language_codes=MEETING_LANGUAGE_CODES
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

        realtime_model = google.realtime.RealtimeModel(**llm_kwargs)
        if is_meeting:
            # A moderator has to be able to talk over people. By default the
            # framework holds every reply back until the room is silent, so an
            # interruption only came out once the speaker had stopped by
            # themselves (measured: 9-12 s after the decision to interrupt).
            # With NO_INTERRUPTION the server already lets the model and the
            # room speak at the same time; this tells the framework the same.
            # livekit-plugins-google does not declare the capability itself.
            realtime_model.capabilities.supports_overlapping_speech = True

        session_kwargs["llm"] = realtime_model
        session = AgentSession(**session_kwargs)
        return session

    async def start_session(self, ctx: JobContext, participant: rtc.RemoteParticipant):
        """Start the initial agent session"""
        self.ctx = ctx
        self.participant = participant

        tools = []
        if self.current_config.meeting_config:
            logger.info("Meeting Moderator tools enabled")
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
        self.attach_session_events(self.current_session)

        await self.current_session.start(
            room=ctx.room,
            agent=self.current_agent,
        )

        self.start_limit_watch()

        # Initial state sync to web clients if meeting is active
        if self.current_config.meeting_config:
            self.gate.hold(OPENING_GRACE_SECONDS)
            self.start_detector()
            await self.publish_meeting_data({
                "type": "state_sync",
                "state": {
                    "currentAgendaIndex": self.current_agenda_index,
                    "elapsedSeconds": self.get_elapsed_seconds(),
                    "decisions": self.decisions,
                    "openItems": self.open_items,
                    "calledAttendeeIds": [],
                    "intervention": self.gate.settings.to_dict(),
                    "detectorActive": self.detector is not None,
                }
            })

        # Register RPC methods BEFORE the opening announcement, so a participant
        # clicking "立即纠偏" / "推进议题" while the greeting is being spoken never
        # hits an unregistered method.

        def on_config_stream(reader: rtc.TextStreamReader, identity: str):
            self._spawn(self.receive_config(reader, identity))

        ctx.room.register_text_stream_handler("pg.config", on_config_stream)

        # Register RPC method for config updates
        @ctx.room.local_participant.register_rpc_method("pg.updateConfig")
        async def update_config(data: rtc.rpc.RpcInvocationData):
            if self.current_session is None or data.caller_identity != participant.identity:
                logger.info("update_config called by non-participant or no session")
                return json.dumps({"changed": False})

            payload = data.payload
            config_key = (json.loads(payload) or {}).get("config_key")
            if config_key:
                payload = await self.take_config(config_key, data.caller_identity)
                if payload is None:
                    logger.warning(f"update_config: config {config_key} never arrived")
                    return json.dumps({"changed": False, "error": "config_not_received"})
            logger.info(
                f"update_config called by {data.caller_identity}: "
                f"{redact_config_payload(payload)}"
            )

            new_config = parse_session_config(json.loads(payload))
            # The browser only sends a key the user typed in; when the key lives
            # on the server the field is empty and must not wipe the one in use.
            new_config.gemini_api_key = (
                new_config.gemini_api_key or self.current_config.gemini_api_key
            )

            old_config = self.current_config
            if old_config == new_config:
                logger.info("config not changed at all")
                return json.dumps({"changed": False})

            self.current_config = new_config
            self.gate.settings.update(
                (new_config.meeting_config or {}).get("intervention") or {}
            )

            if old_config.session_fingerprint() == new_config.session_fingerprint():
                logger.info(f"intervention settings updated: {self.gate.settings.to_dict()}")
                await self.publish_intervention_settings()
                return json.dumps({"changed": True, "restarted": False})

            logger.info(f"config changed, restarting the session for {participant.identity}")
            await self.replace_session(ctx, participant, new_config, old_config)
            return json.dumps({"changed": True, "restarted": True})

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
                self.on_agenda_changed()
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

                # A person asked for it: always granted, and it restarts the
                # cooldown so the detectors do not pile on right afterwards.
                intervention = self.gate.try_acquire("manual")
                intervention.reason = reason
                intervention.transcript_at = self.last_transcript_wall or None

                # 半自动模式下点「打断并引导」：沿用那条建议的判定结果
                suggestion = self.last_suggestion
                if suggestion and suggestion.get("suggestionId") == payload.get("suggestionId"):
                    intervention.reason = suggestion.get("reason") or reason
                    intervention.reason_code = suggestion.get("reasonCode") or ""
                    intervention.confidence = suggestion.get("confidence")
                    self.last_suggestion = None

                if self.detector is not None:
                    self.detector.reset()
                await self.publish_drift_warning(intervention)

                if self.current_session:
                    # Not awaited: the RPC must return before LiveKit's timeout,
                    # and the speech itself is scheduled by the session.
                    intervention.handle = self.speak_interruption(intervention)

                return json.dumps({"success": True, "interventionId": intervention.id})
            except Exception as err:
                logger.error(f"Error handling forceIntervene RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

        # 撤销打断：AI 判断错了，让发言人继续
        @ctx.room.local_participant.register_rpc_method("pg.undoIntervene")
        async def undo_intervene_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.undoIntervene called by {data.caller_identity}: {data.payload}")
            try:
                payload = json.loads(data.payload) if data.payload else {}

                # 半自动模式下点「忽略」：没有人被打断，只记一次误判
                if payload.get("dismissed"):
                    suggestion, self.last_suggestion = self.last_suggestion, None
                    if suggestion:
                        self.gate.record_false_positive({
                            **suggestion,
                            "threshold": self.gate.settings.threshold,
                            "dismissed": True,
                        })
                    return json.dumps({"success": True})

                intervention = self.gate.undo(payload.get("interventionId"))
                if intervention is None:
                    return json.dumps({"success": False, "error": "没有可撤销的打断"})

                await self.silence_intervention(intervention)
                logger.info(
                    f"intervention {intervention.id} undone "
                    f"(source={intervention.source}, confidence={intervention.confidence}); "
                    f"{len(self.gate.false_positives)} false positives so far"
                )
                await self.publish_meeting_data({
                    "type": "intervention_undone",
                    "interventionId": intervention.id,
                    "cooldownSeconds": int(self.gate.cooldown_remaining()),
                    "falsePositive": self.gate.false_positives[-1],
                })
                return json.dumps({"success": True})
            except Exception as err:
                logger.error(f"Error handling undoIntervene RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

        # 会中切换介入模式 / 阈值 / 冷却：原地生效，不重建会话
        @ctx.room.local_participant.register_rpc_method("pg.updateIntervention")
        async def update_intervention_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.updateIntervention called by {data.caller_identity}: {data.payload}")
            try:
                payload = json.loads(data.payload) if data.payload else {}
                self.gate.settings.update(payload if isinstance(payload, dict) else {})
                if self.current_config.meeting_config is not None:
                    self.current_config.meeting_config["intervention"] = (
                        self.gate.settings.to_dict()
                    )
                await self.publish_intervention_settings()
                return json.dumps({"success": True, **self.gate.settings.to_dict()})
            except Exception as err:
                logger.error(f"Error handling updateIntervention RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

        @ctx.room.local_participant.register_rpc_method("pg.endMeeting")
        async def end_meeting_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.endMeeting called by {data.caller_identity}")

            async def end_soon():
                # the answer has to leave before the room is deleted
                await asyncio.sleep(0.3)
                await self.end_meeting("manual")

            self._spawn(end_soon())
            return json.dumps({"success": True})

        @ctx.room.local_participant.register_rpc_method("pg.extendMeeting")
        async def extend_meeting_rpc(data: rtc.rpc.RpcInvocationData):
            logger.info(f"pg.extendMeeting called by {data.caller_identity}")
            watch = self.limit_watch
            if watch is None:
                return json.dumps({"success": False, "error": "没有正在进行的会议"})
            left = watch.extend(time.monotonic())
            await self.publish_meeting_data({"type": "meeting_ending", "active": False})
            return json.dumps({"success": True, "secondsLeft": int(left)})

        # The assistant does not open a meeting: the chair does. Without a
        # meeting there is nobody to wait for, and it greets as before.
        if not self.current_config.meeting_config:
            self.cue_model(OPENING_CUE_DEFAULT)

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

        await self.current_session.aclose()

        tools = []
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
        self.attach_session_events(self.current_session)

        await self.current_session.start(
            room=ctx.room,
            agent=self.current_agent,
        )

        if config.meeting_config:
            # The new session is handed the conversation so far and tends to
            # react to it as if it had just been said.
            self.gate.hold(OPENING_GRACE_SECONDS)
            self.start_detector()
        else:
            await self.stop_detector()

        # Best effort: on gemini-3.1 the replayed (text) history makes the model
        # answer the very first realtime *text* turn as text only, so this
        # announcement may stay silent there; normal audio turns are unaffected.
        try:
            if config.meeting_config and not old_config.meeting_config:
                logger.info("Meeting mode newly enabled")
                self.cue_model(
                    "Briefly announce that Meeting Moderator mode is now active with the configured agenda.",
                )
            elif config.meeting_config:
                # A settings change during a meeting is not something to
                # announce: the moderator would talk over the discussion.
                logger.info("Session restarted with new config (meeting in progress, no announcement)")
            else:
                logger.info("Session restarted with new config")
                self.cue_model(
                    "Briefly acknowledge that your configuration has been updated and you're ready to continue"
                )
        except Exception as e:
            logger.error(f"Failed to notify user about config change: {e}")


if __name__ == "__main__":
    # Kept for backwards compatibility (`python main.py start|console`).
    # The built-in Python CLI is deprecated since livekit-agents 1.8: use
    # `lk agent dev` locally and `python -m livekit.agents start` in production.
    cli.run_app(server)
