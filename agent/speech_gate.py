"""Keeps the moderator quiet when the model says that it says nothing.

Gemini Live is asked to stay silent while people discuss. Most of the time it
produces nothing at all, but now and then it answers with a placeholder
("<!-- This is a comment, no speech is generated -->", "（静默）") and with
up to two seconds of sound to go with it, in the middle of somebody's remark.

The text of an answer arrives together with its first audio. The gate holds
the audio back for a moment, looks at how the text begins, and drops the whole
answer if it is such a placeholder.

No dependency on livekit, so that it can be tested.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterable, AsyncIterator
from typing import Callable, TypeVar

#: what a placeholder begins with; something spoken begins with a word
_PLACEHOLDER_STARTS = ("<", "（", "(", "[", "【", "*", "`", "{", ".", "…", "。", "-", "—", "~")

Frame = TypeVar("Frame")


#: blanks, the invisible ones included
_BLANKS = " " + chr(9) + chr(10) + chr(13) + chr(0x200B) + chr(0x200C) + chr(0x200D) + chr(0xFEFF)
#: how much of an answer is looked at to tell its language
_LANGUAGE_SAMPLE = 12


def _is_chinese(char: str) -> bool:
    return chr(0x4E00) <= char <= chr(0x9FFF)


def is_placeholder(text: str, chinese: bool = False, complete: bool = False) -> bool | None:
    """True for a placeholder, False for speech, None when there is no telling yet.

    With `chinese` the moderator is known to speak Chinese: an answer without
    a Chinese character in its first words ("I will not provide any output.")
    is the model talking to itself. `complete` says that no more text follows.
    """
    begun = text.lstrip(_BLANKS)
    if not begun:
        return True if complete and text else None
    if begun.startswith(_PLACEHOLDER_STARTS):
        return True
    if not chinese or _is_chinese(begun[0]):
        return False
    sample = begun[:_LANGUAGE_SAMPLE]
    if any(_is_chinese(c) for c in sample):
        return False
    if len(begun) < _LANGUAGE_SAMPLE and not complete:
        return None
    return True


def hold_seconds() -> float:
    try:
        return max(float(os.environ.get("SPEECH_GATE_MS", "") or 400) / 1000, 0.0)
    except ValueError:
        return 0.4


class Answer:
    """One answer of the model: its audio and its text."""

    def __init__(self, chinese: bool = False) -> None:
        self.chinese = chinese
        self.text = ""
        self.placeholder: bool | None = None
        self.decided = asyncio.Event()
        self.first_audio_at: float | None = None
        self.first_text_at: float | None = None
        self.dropped_seconds = 0.0
        self.claimed = False
        self.created_at = time.monotonic()

    def heard_text(self, chunk: str, complete: bool = False) -> None:
        if self.placeholder is not None:
            return
        self.text += chunk
        verdict = is_placeholder(self.text, self.chinese, complete)
        if verdict is None:
            return
        self.first_text_at = time.monotonic()
        self.placeholder = verdict
        self.decided.set()


class SpeechGate:
    def __init__(
        self, on_dropped: Callable[[Answer], None] | None = None, chinese: bool = False
    ) -> None:
        self._answers: list[Answer] = []
        self._on_dropped = on_dropped
        #: the moderator speaks Chinese: an answer in another language is not speech
        self.chinese = chinese
        self.hold = hold_seconds()
        #: when the moderator was last given something to say (monotonic)
        self.last_audio_at = 0.0
        self._drop_next_until = 0.0

    def drop_next(self, seconds: float = 10.0) -> None:
        """The next answer is not to be heard, whatever it says. For the answer
        to a tool that has the system speak: told to keep quiet, the model has
        read that very instruction out to the room."""
        self._drop_next_until = time.monotonic() + seconds

    def keep_next(self) -> None:
        """Calls drop_next off: the model has something to say after all."""
        self._drop_next_until = 0.0

    # The framework asks for the audio of an answer first and for its text
    # right after, in the same task.

    def _for_audio(self) -> Answer:
        answer = Answer(self.chinese)
        self._answers.append(answer)
        del self._answers[:-4]
        return answer

    def _for_text(self) -> Answer | None:
        answer = self._answers[-1] if self._answers else None
        if answer is None or answer.claimed or time.monotonic() - answer.created_at > 1.0:
            # an answer without audio: nothing to hold back
            return None
        answer.claimed = True
        return answer

    # Both are plain functions that return the stream: which answer a stream
    # belongs to is settled when the framework asks, not when it starts reading.

    def audio(
        self,
        frames: AsyncIterable[Frame],
        seconds_of: Callable[[Frame], float] = lambda frame: getattr(frame, "duration", 0.0),
    ) -> AsyncIterator[Frame]:
        return self._audio(self._for_audio(), frames, seconds_of)

    def text(self, chunks: AsyncIterable[str]) -> AsyncIterator[str]:
        return self._text(self._for_text(), chunks)

    async def _audio(
        self,
        answer: Answer,
        frames: AsyncIterable[Frame],
        seconds_of: Callable[[Frame], float],
    ) -> AsyncIterator[Frame]:
        held: list[Frame] = []
        released = False
        async for frame in frames:
            if answer.first_audio_at is None and time.monotonic() < self._drop_next_until:
                # the first answer that has a sound is the one meant
                self._drop_next_until = 0.0
                answer.text = "(unwanted answer)"
                answer.placeholder = True
                answer.decided.set()
            if answer.placeholder:
                answer.dropped_seconds += seconds_of(frame)
                continue
            if released:
                self.last_audio_at = time.monotonic()
                yield frame
                continue

            held.append(frame)
            if answer.first_audio_at is None:
                answer.first_audio_at = time.monotonic()
            waited = time.monotonic() - answer.first_audio_at
            if answer.placeholder is None and waited < self.hold:
                continue
            if answer.placeholder:
                answer.dropped_seconds += sum(seconds_of(f) for f in held)
                held.clear()
                continue
            # it is speech, or the text is late: better a sound too many
            # than a moderator who loses the beginning of a sentence
            released = True
            self.last_audio_at = time.monotonic()
            for kept in held:
                yield kept
            held.clear()

        if held:
            # a short answer: the audio is over before the hold is
            if answer.placeholder is None and answer.first_audio_at is not None:
                left = self.hold - (time.monotonic() - answer.first_audio_at)
                if left > 0:
                    try:
                        await asyncio.wait_for(answer.decided.wait(), left)
                    except asyncio.TimeoutError:
                        pass
            if answer.placeholder:
                answer.dropped_seconds += sum(seconds_of(f) for f in held)
            else:
                self.last_audio_at = time.monotonic()
                for kept in held:
                    yield kept

        if answer.placeholder and self._on_dropped is not None:
            self._on_dropped(answer)

    async def _text(self, answer: Answer | None, chunks: AsyncIterable[str]) -> AsyncIterator[str]:
        if answer is None:
            async for chunk in chunks:
                yield chunk
            return
        waiting: list[str] = []
        async for chunk in chunks:
            answer.heard_text(str(chunk))
            if answer.placeholder:
                continue
            if answer.placeholder is None:
                # blanks, or words that do not tell yet what this is
                waiting.append(chunk)
                continue
            for kept in waiting:
                yield kept
            waiting.clear()
            yield chunk
        if answer.placeholder is None:
            answer.heard_text("", complete=True)
            if answer.placeholder is False:
                for kept in waiting:
                    yield kept
