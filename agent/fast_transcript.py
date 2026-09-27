"""A second, faster ear for the off-topic detection.

The Live model hands over what people said only when they pause: somebody
who talks for twenty seconds without a break is heard twenty seconds late.
This module listens to the same microphone with a streaming transcription
model that reports what it has so far while the person is still speaking.

Its text is used for the off-topic judgment only. The transcript on the
kanban and in the minutes stays the one of the Live model.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Callable

from livekit import rtc

logger = logging.getLogger("gemini-playground")

DEFAULT_MODEL = "gemini-3.5-transcribe-live"
SAMPLE_RATE = 16000
#: Nothing heard from the service for this long, although it was given audio:
#: the detection goes back to the Live model's transcript.
STALE_SECONDS = 20.0


class FastTranscript:
    def __init__(
        self,
        room: rtc.Room,
        participant_identity: str,
        on_text: Callable[[str, str, bool], None],
        *,
        api_key: str,
        model: str = DEFAULT_MODEL,
        language_codes: list[str] | None = None,
        vocabulary: list[str] | None = None,
    ):
        self._room = room
        self._identity = participant_identity
        self._on_text = on_text
        self._api_key = api_key
        self._model = model
        self._language_codes = language_codes
        self._vocabulary = vocabulary
        self._task: asyncio.Task | None = None
        self._utterance = 0
        self._last_event = 0.0
        self._started = 0.0
        self._failed = False

    @property
    def healthy(self) -> bool:
        """Whether the detection should rely on this feed right now."""
        if self._task is None or self._task.done() or self._failed:
            return False
        reference = self._last_event or self._started
        return time.monotonic() - reference < STALE_SECONDS or self._last_event == 0.0

    def start(self) -> None:
        if self._task is None:
            self._started = time.monotonic()
            self._task = asyncio.create_task(self._run())

    async def aclose(self) -> None:
        task, self._task = self._task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    def _microphone(self) -> rtc.Track | None:
        participant = self._room.remote_participants.get(self._identity)
        if participant is None:
            return None
        for publication in participant.track_publications.values():
            if publication.kind == rtc.TrackKind.KIND_AUDIO and publication.track:
                return publication.track
        return None

    async def _run(self) -> None:
        # imported here: the plugin pulls in the Google SDK, which the unit
        # tests of the modules around this one do not need
        from livekit.agents import stt
        from livekit.plugins.google.beta import gemini_stt

        try:
            track = None
            while track is None:
                track = self._microphone()
                if track is None:
                    await asyncio.sleep(0.2)

            recognizer = gemini_stt.STT(
                model=self._model,
                language=None,
                language_codes=self._language_codes,
                custom_vocabulary=self._vocabulary,
                sample_rate=SAMPLE_RATE,
                api_key=self._api_key,
            )
            stream = recognizer.stream()
            audio = rtc.AudioStream(track, sample_rate=SAMPLE_RATE, num_channels=1)

            async def feed() -> None:
                async for event in audio:
                    stream.push_frame(event.frame)

            feeder = asyncio.create_task(feed())
            logger.info(f"fast transcript started ({self._model})")
            try:
                async for event in stream:
                    if not event.alternatives:
                        continue
                    text = event.alternatives[0].text.strip()
                    if not text:
                        continue
                    self._last_event = time.monotonic()
                    final = event.type == stt.SpeechEventType.FINAL_TRANSCRIPT
                    self._on_text(f"fast-{self._utterance}", text, final)
                    if final:
                        self._utterance += 1
            finally:
                feeder.cancel()
                await asyncio.gather(feeder, return_exceptions=True)
                await audio.aclose()
                await stream.aclose()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            # the meeting goes on with the slower transcript
            self._failed = True
            logger.warning(f"fast transcript stopped: {e!r}")
