"""When a meeting ends by itself.

A meeting that is left open keeps costing money: the room's audio is streamed
to the Live model and to the transcription for as long as the browser tab is
connected, whether or not anybody is in the room. Two rules end it:

- nobody has said anything for a while (the tab was forgotten), and
- the meeting has run far beyond its planned length.

Both announce themselves first, so a meeting that is still going on can be
kept open: by speaking in the first case, by extending it in the second.

No dependency on livekit: the clock is passed in, which makes it testable.
"""

from __future__ import annotations

import os
from dataclasses import dataclass

IDLE = "idle"
LIMIT = "limit"


def _minutes(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, "").strip() or default)
    except ValueError:
        return default
    return value if value > 0 else default


@dataclass
class MeetingLimits:
    #: nobody spoke for this long: the ending is announced
    idle_seconds: float = 600.0
    #: and this long after the announcement the meeting ends
    idle_grace_seconds: float = 60.0
    #: the meeting ends at this age, whatever happens in it
    max_seconds: float = 7200.0
    #: how long before that the ending is announced
    limit_notice_seconds: float = 300.0
    #: what one extension adds
    extension_seconds: float = 1800.0

    @classmethod
    def for_meeting(cls, planned_minutes: float | None) -> MeetingLimits:
        """Twice the planned length, at least half an hour more than planned,
        and never beyond MEETING_MAX_MINUTES."""
        planned = max(float(planned_minutes or 0), 0.0)
        ceiling = _minutes("MEETING_MAX_MINUTES", 240)
        allowed = min(max(planned * 2, planned + 30), ceiling) if planned else ceiling
        return cls(
            idle_seconds=_minutes("MEETING_IDLE_MINUTES", 10) * 60,
            max_seconds=allowed * 60,
        )


@dataclass
class Notice:
    """The meeting is about to end."""

    reason: str
    seconds_left: float


@dataclass
class End:
    reason: str


class LimitWatch:
    def __init__(self, limits: MeetingLimits, now: float):
        self.limits = limits
        self.started_at = now
        self.last_heard = now
        self.ends_at = now + limits.max_seconds
        self.idle_noticed_at: float | None = None
        self.limit_noticed = False

    def heard(self, now: float) -> bool:
        """Somebody in the room spoke. True if that called off an ending."""
        self.last_heard = now
        called_off = self.idle_noticed_at is not None
        self.idle_noticed_at = None
        return called_off

    def extend(self, now: float) -> float:
        """Somebody asked for more time. Returns the seconds left after it."""
        self.heard(now)
        self.ends_at = max(self.ends_at, now) + self.limits.extension_seconds
        self.limit_noticed = False
        return self.ends_at - now

    def check(self, now: float) -> Notice | End | None:
        """What is due now. A notice is given once."""
        if now >= self.ends_at:
            return End(LIMIT)
        if self.idle_noticed_at is not None:
            if now - self.idle_noticed_at >= self.limits.idle_grace_seconds:
                return End(IDLE)
        elif now - self.last_heard >= self.limits.idle_seconds:
            self.idle_noticed_at = now
            return Notice(IDLE, self.limits.idle_grace_seconds)
        if not self.limit_noticed and self.ends_at - now <= self.limits.limit_notice_seconds:
            self.limit_noticed = True
            return Notice(LIMIT, self.ends_at - now)
        return None
