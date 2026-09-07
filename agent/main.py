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
    AgentSession,
    AutoSubscribe,
    JobContext,
    WorkerOptions,
    WorkerType,
    cli,
    function_tool,
    utils,
)
from livekit.plugins import google

# Load .env.local from current directory or parent directory
load_dotenv(dotenv_path=".env.local")
load_dotenv(dotenv_path="../.env.local")

logger = logging.getLogger("gemini-playground")
logger.setLevel(logging.INFO)

# Suppress OpenTelemetry attribute warnings
logging.getLogger("opentelemetry.attributes").setLevel(logging.ERROR)


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
                    "description": "Creative, detailed, and sophisticated description of the image to generate (e.g., 'a cat eating a nano-banana in a fancy restaurant'), not simply a few words. Not a generic prompt such as 'image of a cat' or 'random image'."
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


def create_get_meeting_timer_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "get_meeting_timer",
        "description": "获取当前会议的已用时长、剩余时长、总计划时间以及当前正在讨论的议题信息。",
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

        if 0 <= idx < len(agendas):
            cur = agendas[idx]
            cur_title = cur.get("title", f"议题 {idx + 1}")
            cur_duration = cur.get("durationMinutes", 0)
            cur_goal = cur.get("goal", "")
            return (
                f"会议已进行 {elapsed_mins}分{rem_secs}秒 (总预计 {total_mins} 分钟)。"
                f"当前进行第 {idx + 1}/{len(agendas)} 项议题：【{cur_title}】"
                f"(计划用时 {cur_duration} 分钟，核心目标: {cur_goal})。"
            )
        return f"会议已进行 {elapsed_mins}分{rem_secs}秒 (总预计 {total_mins} 分钟)。目前所有计划议程已讨论完毕。"

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
        target_idx = max(0, item_index - 1)
        session_manager.current_agenda_index = target_idx

        cfg = session_manager.current_config.meeting_config or {}
        agendas = cfg.get("agendas", [])

        await session_manager.publish_meeting_data({
            "type": "advance_agenda",
            "currentAgendaIndex": target_idx,
            "summary": summary,
        })

        title = agendas[target_idx].get("title", f"议题 {item_index}") if 0 <= target_idx < len(agendas) else f"第 {item_index} 项"
        return f"会议议程已更新至第 {item_index} 项：【{title}】。前台看板已同步更新。"

    return advance_agenda


def create_record_decision_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "record_decision",
        "description": "记录会议中达成的明确决议或 Action Item 待办事项，同步展示在前台看板和最终纪要中。",
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
                    "description": "该事项的明确责任人/执行人（如'张三'、'前端团队'、'产品组'）",
                },
                "due_date": {
                    "type": "string",
                    "description": "交付时间或截止日期（如'本周五'、'下周二前'、'9月15日'）",
                },
            },
            "required": ["decision"],
            "additionalProperties": False,
        },
    }

    @function_tool(raw_schema=raw_schema)
    async def record_decision(raw_arguments: dict) -> str:
        decision_text = raw_arguments.get("decision", "")
        cfg = session_manager.current_config.meeting_config or {}
        agendas = cfg.get("agendas", [])
        idx = session_manager.current_agenda_index
        default_agenda_title = agendas[idx].get("title", "") if 0 <= idx < len(agendas) else "通用决议"
        agenda_title = raw_arguments.get("agenda_title") or default_agenda_title
        owner = raw_arguments.get("owner") or "待定"
        due_date = raw_arguments.get("due_date") or "待定"

        decision_item = {
            "id": f"dec-{uuid.uuid4().hex[:8]}",
            "agendaTitle": agenda_title,
            "decision": decision_text,
            "owner": owner,
            "dueDate": due_date,
            "timestamp": int(time.time() * 1000),
        }
        session_manager.decisions.append(decision_item)

        await session_manager.publish_meeting_data({
            "type": "new_decision",
            "decision": decision_item,
        })

        return f"已成功固化决议：【{decision_text}】（议题：{agenda_title}，负责人：{owner}，完成时间：{due_date}），并已同步至前台看板。"

    return record_decision


def create_warn_topic_drift_tool(session_manager: SessionManager):
    raw_schema = {
        "type": "function",
        "name": "warn_topic_drift",
        "description": "当参会人员讨论明显偏离当前议程核心目标时，触发前台看板醒目的跑题黄牌警示，并辅助口头委婉干预提醒大家回归主题。",
        "parameters": {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "讨论偏离当前主题的简要说明（例如：'正讨论上周复盘，但话题偏向了下季度团建规划'）",
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

        return f"已在前台看板显示跑题提醒：{reason}。请同时用得体口吻简短提醒大家回归当前议程。"

    return warn_topic_drift


def create_meeting_tools(session_manager: SessionManager):
    return [
        create_get_meeting_timer_tool(session_manager),
        create_advance_agenda_tool(session_manager),
        create_record_decision_tool(session_manager),
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
        self.overtime_alerted: set[int] = set()
        self.monitor_task: asyncio.Task | None = None

    def get_elapsed_seconds(self) -> int:
        if self.meeting_start_time is None:
            return 0
        return int(time.time() - self.meeting_start_time)

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

    def create_session(self, config: SessionConfig) -> AgentSession:
        """Create an AgentSession with the given configuration"""
        session = AgentSession(
            llm=google.realtime.RealtimeModel(
                model=config.model,
                voice=config.voice,
                temperature=config.temperature,
                max_output_tokens=int(config.max_response_output_tokens) if config.max_response_output_tokens != "inf" else None,
                modalities=config.modalities,
                api_key=config.gemini_api_key,
            )
        )
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
                    "driftWarning": False,
                }
            })

        # Greet the user
        await self.current_session.generate_reply(
            instructions="Please begin the interaction with the user in a manner consistent with your instructions."
        )

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
                target_idx = max(0, item_index - 1)
                self.current_agenda_index = target_idx
                await self.publish_meeting_data({
                    "type": "advance_agenda",
                    "currentAgendaIndex": target_idx,
                })
                return json.dumps({"success": True, "currentAgendaIndex": target_idx})
            except Exception as err:
                logger.error(f"Error handling advanceAgenda RPC: {err}")
                return json.dumps({"success": False, "error": str(err)})

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

        try:
            if nano_banana_newly_enabled:
                logger.info("Nano Banana tool newly enabled")
                await self.current_session.generate_reply(
                    instructions="Briefly and enthusiastically announce: 'Nano Banana now active, feel free to ask me to generate an image and I can show you whatever you like!'",
                )
            elif config.meeting_config and not old_config.meeting_config:
                logger.info("Meeting mode newly enabled")
                await self.current_session.generate_reply(
                    instructions="Briefly announce that Meeting Moderator mode is now active with the configured agenda.",
                )
            else:
                logger.info("Session restarted with new config")
                await self.current_session.generate_reply(
                    instructions=is_nano_banana_enabled and "Briefly acknowledge that your configuration has been updated and you're ready to continue and announce that you can also generate images now!" or "Briefly acknowledge that your configuration has been updated and you're ready to continue"
                )
        except Exception as e:
            logger.error(f"Failed to notify user about config change: {e}")


if __name__ == "__main__":
    cli.run_app(WorkerOptions(agent_name='gemini-playground', entrypoint_fnc=entrypoint, worker_type=WorkerType.ROOM))
