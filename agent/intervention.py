"""Who may speak up about a digression, and when.

Two detectors can decide that the discussion went off topic: the Jev drift
detector (code-driven) and the Live model itself (``warn_topic_drift``). Both
ask this gate before anybody speaks, so they share one cooldown and never
interrupt twice for the same digression.

Kept free of livekit imports so it can be unit-tested on its own.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Literal

# The words of an interruption are in phrasebook.py; re-exported because the
# gate and its tests are where they were used first.
from phrasebook import INTERRUPTION_REASONS, spoken_interruption  # noqa: F401

InterventionMode = Literal["auto", "semi_auto"]
InterventionSource = Literal["jev", "model", "manual"]

#: Prompting, not interrupting: the assistant shows a suggestion to the chair
#: and speaks only when asked to (auto is opt-in per meeting).
DEFAULT_MODE: InterventionMode = "semi_auto"
DEFAULT_THRESHOLD = 0.85
DEFAULT_COOLDOWN_SECONDS = 45.0
DEFAULT_CONSECUTIVE_HITS = 1

#: Nobody is interrupted right after the agenda moved on: the first sentences
#: on a new topic are usually a recap of the previous one.
AGENDA_GRACE_SECONDS = 15.0
#: An undone interruption was a false positive; back off for longer.
UNDO_COOLDOWN_FACTOR = 2.0


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


@dataclass
class InterventionSettings:
    mode: InterventionMode = DEFAULT_MODE
    threshold: float = DEFAULT_THRESHOLD
    cooldown_seconds: float = DEFAULT_COOLDOWN_SECONDS
    consecutive_hits: int = DEFAULT_CONSECUTIVE_HITS

    @classmethod
    def from_dict(cls, raw: Any) -> "InterventionSettings":
        """Build settings from the ``intervention`` block of the meeting config.

        Tolerates a missing block and out-of-range values: the config comes
        from the browser and from presets saved by older builds.
        """
        settings = cls()
        if isinstance(raw, dict):
            settings.update(raw)
        return settings

    def update(self, raw: dict) -> None:
        mode = raw.get("mode")
        if mode in ("auto", "semi_auto"):
            self.mode = mode
        for key, attr, low, high in (
            ("threshold", "threshold", 0.5, 0.99),
            ("cooldownSeconds", "cooldown_seconds", 5.0, 600.0),
        ):
            try:
                if raw.get(key) is not None:
                    setattr(self, attr, _clamp(float(raw[key]), low, high))
            except (TypeError, ValueError):
                pass
        try:
            if raw.get("consecutiveHits") is not None:
                self.consecutive_hits = int(_clamp(int(raw["consecutiveHits"]), 1, 5))
        except (TypeError, ValueError):
            pass

    def to_dict(self) -> dict:
        return {
            "mode": self.mode,
            "threshold": self.threshold,
            "cooldownSeconds": self.cooldown_seconds,
            "consecutiveHits": self.consecutive_hits,
        }


@dataclass
class Intervention:
    id: str
    source: InterventionSource
    started_at: float
    confidence: float | None = None
    reason: str = ""
    reason_code: str = ""
    excerpt: str = ""
    #: Wall-clock time of the last transcript update that was judged.
    transcript_at: float | None = None
    jev_ms: int | None = None
    published_at: float | None = None
    speech_started_at: float | None = None
    undone: bool = False
    #: Set by the agent: the SpeechHandle speaking this interruption.
    handle: Any = None
    #: Undo arrived before the speech existed; cancel it as soon as it does.
    pending_cancel: bool = False


@dataclass
class InterventionGate:
    settings: InterventionSettings = field(default_factory=InterventionSettings)
    clock: Callable[[], float] = time.monotonic

    _cooldown_until: float = 0.0
    _hold_until: float = 0.0
    _suggestion_until: float = 0.0
    active: Intervention | None = None
    false_positives: list[dict] = field(default_factory=list)

    def hold(self, seconds: float = AGENDA_GRACE_SECONDS) -> None:
        """Refuse automatic interruptions for a while (opening, new agenda item)."""
        self._hold_until = max(self._hold_until, self.clock() + seconds)

    def cooldown_remaining(self) -> float:
        return max(0.0, max(self._cooldown_until, self._hold_until) - self.clock())

    def try_acquire(
        self,
        source: InterventionSource,
        *,
        agent_speaking: bool = False,
    ) -> Intervention | None:
        """Ask for permission to interrupt. Returns the intervention, or None.

        A manual request (the 立即纠偏 button) always passes, but still starts
        the cooldown so the detectors do not pile on right after it.
        """
        now = self.clock()
        if source != "manual":
            if now < self._cooldown_until or now < self._hold_until:
                return None
            # The moderator is already talking. On Gemini 3.8 a new cue would
            # cut that sentence off mid-word.
            if agent_speaking:
                return None

        self._cooldown_until = now + self.settings.cooldown_seconds
        self.active = Intervention(
            id=f"int-{uuid.uuid4().hex[:8]}",
            source=source,
            started_at=now,
        )
        return self.active

    def try_suggest(self, ttl_seconds: float) -> str | None:
        """Semi-automatic mode: ask to show a suggestion instead of interrupting.

        Nothing is said, so the cooldown does not start; the suggestion only
        blocks further suggestions while it is on screen.
        """
        now = self.clock()
        if now < max(self._cooldown_until, self._hold_until, self._suggestion_until):
            return None
        self._suggestion_until = now + ttl_seconds
        return f"sug-{uuid.uuid4().hex[:8]}"

    def undo(self, intervention_id: str | None = None) -> Intervention | None:
        """Mark the active interruption as a false positive and back off."""
        target = self.active
        if target is None or target.undone:
            return None
        if intervention_id and target.id != intervention_id:
            return None

        target.undone = True
        self._cooldown_until = (
            self.clock() + self.settings.cooldown_seconds * UNDO_COOLDOWN_FACTOR
        )
        self.record_false_positive(
            {
                "interventionId": target.id,
                "source": target.source,
                "confidence": target.confidence,
                "reasonCode": target.reason_code,
                "excerpt": target.excerpt,
                "threshold": self.settings.threshold,
            }
        )
        return target

    def record_false_positive(self, record: dict) -> None:
        self.false_positives.append({**record, "at": time.time()})
