"""Per-model capabilities of the Gemini Live models this agent supports.

Kept free of livekit / google imports so it can be unit-tested on its own.

Every Live model generation changed what the session setup accepts, and
guessing from a substring of the model id ("3.1" in model) silently put new
models on the wrong code path. The table below is the single place that says
what each model takes; anything not listed falls back to the default model.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

DEFAULT_LIVE_MODEL = "gemini-3.8-live"


@dataclass(frozen=True)
class ModelCaps:
    #: The session setup accepts ``proactivity`` (proactive audio on/off).
    #: False for 3.1 (not supported) and 3.8 (permanently on; the flag is
    #: rejected, and passing it moves the plugin onto the v1alpha API).
    supports_proactivity_flag: bool
    #: Audio is the only response modality; text comes from output transcription.
    audio_only: bool
    #: Explicit tool behavior to request, or None to keep the plugin default.
    tool_behavior: Literal["BLOCKING", "NON_BLOCKING"] | None
    #: Whether ``temperature`` may be sent in the generation config.
    send_temperature: bool
    #: How to make the model speak on demand. ``realtime_text`` sends the cue as
    #: realtime text input, which the model answers like a spoken turn.
    #: ``generate_reply`` goes through the framework's speech queue. Measured on
    #: gemini-3.8-live: realtime text was answered within 1.5 s, generate_reply
    #: took 3 s at best and sometimes produced nothing at all.
    cue_strategy: Literal["realtime_text", "generate_reply"] = "realtime_text"


_CAPS: dict[str, ModelCaps] = {
    # 3.8 defaults to asynchronous (NON_BLOCKING) function calling. The meeting
    # tools return instructions the model has to follow before it speaks
    # ("暂不推进…", "保持静默…"), so the calls must block.
    "gemini-3.8-live": ModelCaps(
        supports_proactivity_flag=False,
        audio_only=True,
        tool_behavior="BLOCKING",
        send_temperature=False,
    ),
    "gemini-3.8-live-extended-thinking": ModelCaps(
        supports_proactivity_flag=False,
        audio_only=True,
        tool_behavior="BLOCKING",
        send_temperature=False,
    ),
    "gemini-3.1-flash-live-preview": ModelCaps(
        supports_proactivity_flag=False,
        audio_only=False,
        tool_behavior=None,
        send_temperature=True,
    ),
}

SUPPORTED_LIVE_MODELS: tuple[str, ...] = tuple(_CAPS)


def resolve_model(model_id: str | None) -> tuple[str, ModelCaps, bool]:
    """Map a requested model id to a supported one.

    Returns ``(model_id, caps, was_replaced)``. Unknown ids and ids of models
    that were removed (the 2.5 native-audio previews) resolve to the default.
    """
    requested = (model_id or "").strip()
    if requested in _CAPS:
        return requested, _CAPS[requested], False
    return DEFAULT_LIVE_MODEL, _CAPS[DEFAULT_LIVE_MODEL], True
