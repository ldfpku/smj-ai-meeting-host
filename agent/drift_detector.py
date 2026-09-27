"""Off-topic detection on the live transcript, judged by TypeSafe Jev.

Jev is a System One model: it does not generate text, it answers typed
questions with probabilities. That makes the off-topic decision measurable
(a probability the UI can show and a threshold an admin can tune) instead of
something buried in the Live model's prompt.

Kept free of livekit imports so it can be unit-tested on its own. The judge is
injected: production uses :class:`JevJudge`, tests use a stub.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Protocol

from intervention import InterventionSettings

logger = logging.getLogger("gemini-playground.drift")

#: Reasons Jev can pick from. Jev cannot write a reason, it can only select
#: one, so the wording shown to the meeting lives here.
REASON_LABELS: dict[str, str] = {
    "unrelated_chitchat": "无关闲聊",
    "other_agenda_item": "跳到了其他议题",
    "side_issue": "纠缠枝节细节",
    "argument": "争执扯皮",
    "none": "未偏离",
}

#: Above this probability a single judgment is enough, whatever
#: ``consecutive_hits`` says. This is the path that can meet the 3 s target.
FAST_PATH_PROBABILITY = 0.95
#: ``drift_level`` is 0 (on topic) .. 3 (unrelated); 2 is "loosely related tangent".
MIN_DRIFT_LEVEL = 2.0


@dataclass
class DriftJudgment:
    probability: float
    level: float
    reason_code: str
    elapsed_ms: int
    level_confidence: float | None = None
    reason_confidence: float | None = None


@dataclass
class DriftResult:
    judgment: DriftJudgment
    excerpt: str
    #: Wall-clock time of the newest transcript update that was judged.
    transcript_at: float
    hits: int

    @property
    def reason(self) -> str:
        return REASON_LABELS.get(self.judgment.reason_code, "讨论偏离当前议题")


class DriftJudge(Protocol):
    async def judge(self, state: dict) -> DriftJudgment: ...

    async def aclose(self) -> None: ...


class JevJudge:
    """Asks Jev three questions about the recent transcript in one request."""

    def __init__(self, api_key: str, *, timeout: float = 2.5, model: str = "jev-latest"):
        # Imported here so the module (and its tests) load without the SDK.
        import httpx2
        from typesafe_sdk import AsyncTypeSafeClient, Choice, Noul, RetryPolicy, Score

        # One client for the whole meeting, and a connection that stays open
        # through the pauses of a conversation. Measured through the proxy: a
        # judgment takes ~0.4 s on an open connection and ~1.8 s when it has
        # to be re-established, which httpx does after 5 idle seconds by
        # default. No retries: a late answer is worthless here, the next
        # transcript update asks again anyway.
        self._client = AsyncTypeSafeClient(
            api_key=api_key,
            model=model,
            retry=RetryPolicy(max_retries=0, timeout=timeout),
            http_client=httpx2.AsyncClient(
                timeout=timeout,
                limits=httpx2.Limits(
                    max_keepalive_connections=2, keepalive_expiry=600
                ),
            ),
        )
        self._timeout = timeout
        self._questions = {
            "off_topic": Noul(
                instructions=(
                    "Are the `latest_remarks` off the topic of `current_agenda`, so "
                    "that they do not help reach `current_agenda.goal`? "
                    "`earlier_remarks` were said before and are context only."
                ),
                criteria={
                    "true": (
                        "The speakers talk about something that does not help reach "
                        "the goal of the current agenda item"
                    ),
                    "false": (
                        "The speakers discuss the current agenda item or something "
                        "that directly supports its goal; or they talk about running "
                        "the meeting itself (asking the moderator to move on, to "
                        "summarise or to end the meeting, agreeing or disagreeing when "
                        "asked for their position); or `latest_remarks` are too short "
                        "or too garbled to tell"
                    ),
                },
            ),
            "drift_level": Score(
                instructions=(
                    "How far have the `latest_remarks` drifted from the topic in "
                    "`current_agenda`? `earlier_remarks` are context only."
                ),
                criteria=[
                    "fully on the current agenda topic",
                    "a related side issue that still supports the agenda goal",
                    "a loosely related tangent that does not move the agenda goal forward",
                    "completely unrelated to the current agenda topic",
                ],
            ),
            "reason": Choice(
                instructions=(
                    "Which description best fits the `latest_remarks` relative to "
                    "`current_agenda`?"
                ),
                criteria={
                    "unrelated_chitchat": (
                        "Small talk or personal matters unrelated to the meeting"
                    ),
                    "other_agenda_item": (
                        "Work discussion that belongs to one of `other_agenda_titles` "
                        "or to a different project, not to the current agenda item"
                    ),
                    "side_issue": (
                        "Stuck on a minor detail or side issue of the current topic "
                        "that does not move its goal forward"
                    ),
                    "argument": (
                        "Arguing, blaming or complaining about people or departments "
                        "instead of working towards the goal"
                    ),
                    "none": (
                        "The discussion is on the current agenda topic, or it is about "
                        "running the meeting itself"
                    ),
                },
            ),
        }

    @classmethod
    def from_env(cls) -> "JevJudge | None":
        # The project stores the key as JEV_API_KEY; TYPESAFE_API_KEY is the
        # name the SDK documents.
        key = (os.environ.get("JEV_API_KEY") or os.environ.get("TYPESAFE_API_KEY") or "").strip()
        if not key:
            return None
        return cls(key)

    async def judge(self, state: dict) -> DriftJudgment:
        started = time.monotonic()
        response = await asyncio.wait_for(
            self._client.system_one(state=state, questions=self._questions),
            timeout=self._timeout,
        )
        elapsed_ms = int((time.monotonic() - started) * 1000)

        level = response.scores["drift_level"]
        reason = response.choices["reason"]
        return DriftJudgment(
            probability=float(response.nouls["off_topic"].noul),
            level=float(level.score),
            level_confidence=level.confidence,
            reason_code=str(reason.choice),
            reason_confidence=reason.confidence,
            elapsed_ms=elapsed_ms,
        )

    async def aclose(self) -> None:
        close = getattr(self._client, "aclose", None) or getattr(self._client, "close", None)
        if close is None:
            return
        result = close()
        if asyncio.iscoroutine(result):
            await result


_CJK = "　-〿一-鿿＀-￯"
_SPACE_BETWEEN_CJK = re.compile(f"([{_CJK}])\\s+(?=[{_CJK}])")


@dataclass
class _Piece:
    """Text that was added to the transcript at one moment."""

    key: str
    text: str
    at: float  # monotonic
    wall: float


class DriftDetector:
    """Watches the user transcript and reports when it goes off topic.

    Transcript updates arrive as cumulative interim text per ``item_id``; the
    final flag only comes once the model's turn is over, which is far too late
    to interrupt anybody. So the detector judges interim text: once it has been
    stable for a moment or has grown by enough characters.

    What gets judged is what was said in the last few seconds
    (``latest_remarks``). An item is no useful unit for that: while the
    moderator stays silent a single item keeps growing for minutes, and a
    digression at the end of it would be outweighed by everything before.
    Older text is passed along as ``earlier_remarks``, for context only.
    """

    def __init__(
        self,
        judge: DriftJudge,
        *,
        get_context: Callable[[], dict | None],
        get_settings: Callable[[], InterventionSettings],
        on_drift: Callable[[DriftResult], Awaitable[None]],
        on_judgment: Callable[[DriftJudgment], Awaitable[None]] | None = None,
        stable_seconds: float = 0.4,
        growth_chars: int = 15,
        min_interval_seconds: float = 1.0,
        recent_seconds: float = 8.0,
        latest_min_chars: int = 40,
        short_chars: int = 12,
        latest_max_chars: int = 400,
        earlier_max_chars: int = 300,
        max_age_seconds: float = 90.0,
        min_chars: int = 8,
    ):
        self._judge = judge
        self._get_context = get_context
        self._get_settings = get_settings
        self._on_drift = on_drift
        self._on_judgment = on_judgment

        self._stable_seconds = stable_seconds
        self._growth_chars = growth_chars
        self._min_interval = min_interval_seconds
        self._recent_seconds = recent_seconds
        self._latest_min_chars = latest_min_chars
        self._short_chars = short_chars
        self._latest_max_chars = latest_max_chars
        self._earlier_max_chars = earlier_max_chars
        self._max_age = max_age_seconds
        self._min_chars = min_chars

        # the full text last seen per item, to tell what an update added
        self._seen: dict[str, str] = {}
        self._pieces: list[_Piece] = []
        self._anon_seq = 0
        self._anon_last = ""

        self._dirty = False
        self._new_chars = 0
        self._last_update = 0.0
        self._last_call = 0.0
        self._hits = 0
        self._closed = False
        self._runner: asyncio.Task | None = None

    # ---- input -----------------------------------------------------------

    def on_transcript(self, item_id: str | None, text: str) -> None:
        if self._closed or not text:
            return

        # gemini-3.1 puts a space between every Chinese character
        text = _SPACE_BETWEEN_CJK.sub(r"\1", text)
        key = item_id or self._anon_key(text)
        previous = self._seen.get(key, "")
        if text == previous:
            return

        if text.startswith(previous):
            added = text[len(previous) :]
        else:
            # the recognizer revised what it had: take the new version instead
            self._pieces = [p for p in self._pieces if p.key != key]
            added = text
        self._seen[key] = text
        if not added.strip():
            return

        now = time.monotonic()
        self._pieces.append(_Piece(key=key, text=added, at=now, wall=time.time()))
        self._new_chars += len(added)
        self._last_update = now
        self._dirty = True

        if self._runner is None or self._runner.done():
            self._runner = asyncio.create_task(self._run(), name="drift_detector")

    def _anon_key(self, text: str) -> str:
        """Key for updates without an item id: a new one whenever the text stops
        being a continuation of the previous update."""
        if not (self._anon_last and text.startswith(self._anon_last)):
            self._anon_seq += 1
        self._anon_last = text
        return f"_anon-{self._anon_seq}"

    def reset(self) -> None:
        """Forget what was said so far (new agenda item, after an interruption).

        ``_seen`` stays: the items keep growing, and only what is added from
        now on counts towards the next judgment.
        """
        self._pieces.clear()
        self._hits = 0
        self._new_chars = 0
        self._dirty = False

    async def aclose(self) -> None:
        self._closed = True
        if self._runner is not None and not self._runner.done():
            self._runner.cancel()
            try:
                await self._runner
            except (asyncio.CancelledError, Exception):
                pass
        await self._judge.aclose()

    # ---- window ----------------------------------------------------------

    @staticmethod
    def _join(pieces: list[_Piece]) -> str:
        out: list[str] = []
        previous_key = None
        for piece in pieces:
            if previous_key is not None and piece.key != previous_key:
                out.append("\n")
            out.append(piece.text)
            previous_key = piece.key
        return "".join(out).strip()

    def window(self) -> tuple[str, str, float]:
        """``(latest_remarks, earlier_remarks, wall time of the newest update)``."""
        now = time.monotonic()
        self._pieces = [p for p in self._pieces if now - p.at <= self._max_age]
        if not self._pieces:
            return "", "", 0.0

        # The last few seconds of what is being said right now. What somebody
        # else said just before belongs to the context: judged together, an
        # on-topic remark followed by a digression comes out as "half on
        # topic" until the remark is old enough to drop out.
        newest = self._pieces[-1].key
        split = len(self._pieces)
        chars = 0
        while split > 0:
            piece = self._pieces[split - 1]
            if piece.key != newest:
                break
            if now - piece.at > self._recent_seconds and chars >= self._latest_min_chars:
                break
            chars += len(piece.text)
            split -= 1

        # too little to judge on its own ("对", "好的"): add what came before
        if chars < self._short_chars:
            while split > 0 and chars < self._latest_min_chars:
                chars += len(self._pieces[split - 1].text)
                split -= 1

        latest = self._join(self._pieces[split:])[-self._latest_max_chars :]
        earlier = self._join(self._pieces[:split])[-self._earlier_max_chars :]
        return latest, earlier, self._pieces[-1].wall

    # ---- loop ------------------------------------------------------------

    async def _run(self) -> None:
        # Single flight: one judgment at a time. Updates that arrive while a
        # request is in the air only mark the window dirty, and the next pass
        # judges the newest text.
        while self._dirty and not self._closed:
            await self._wait_for_trigger()
            if self._closed:
                return

            self._dirty = False
            self._new_chars = 0
            latest, earlier, transcript_at = self.window()
            if len(latest) < self._min_chars:
                continue

            context = self._get_context()
            if not context:
                continue

            self._last_call = time.monotonic()
            try:
                judgment = await self._judge.judge(
                    {**context, "earlier_remarks": earlier, "latest_remarks": latest}
                )
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Fail open: no judgment means nobody gets interrupted.
                logger.warning(f"drift judgment failed, not interrupting: {e!r}")
                continue

            await self._handle(judgment, latest, transcript_at)

    async def _wait_for_trigger(self) -> None:
        while not self._closed:
            now = time.monotonic()
            settled = (
                now - self._last_update >= self._stable_seconds
                or self._new_chars >= self._growth_chars
            )
            spaced = now - self._last_call >= self._min_interval
            if settled and spaced:
                return
            await asyncio.sleep(0.05)

    async def _handle(self, judgment: DriftJudgment, text: str, transcript_at: float) -> None:
        if self._on_judgment is not None:
            try:
                await self._on_judgment(judgment)
            except Exception as e:
                logger.warning(f"on_judgment callback failed: {e!r}")

        settings = self._get_settings()
        # "off topic" together with the reason "not off topic" is a judgment
        # that contradicts itself: nobody is interrupted on that
        consistent = judgment.reason_code != "none"
        fast = consistent and judgment.probability >= FAST_PATH_PROBABILITY
        hit = fast or (
            consistent
            and judgment.probability >= settings.threshold
            and judgment.level >= MIN_DRIFT_LEVEL
        )
        if not hit:
            self._hits = 0
            return

        self._hits += 1
        if not fast and self._hits < settings.consecutive_hits:
            return

        result = DriftResult(
            judgment=judgment,
            excerpt=text[-120:],
            transcript_at=transcript_at,
            hits=self._hits,
        )
        self.reset()
        try:
            await self._on_drift(result)
        except Exception as e:
            logger.error(f"on_drift callback failed: {e!r}")
