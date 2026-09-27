"""A second audio track of the moderator, for sentences that cannot wait.

What the Live model says goes through the speech queue of the agent session:
one speech at a time, and a prepared sentence waits until the model's current
turn is over. While the model is slow or stuck, nothing gets through. An
interruption that waits is no interruption, so prepared clips are played on
a track of their own, independent of the state the Live session is in.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Callable

from livekit import rtc

from spoken_clips import Clip

logger = logging.getLogger("gemini-playground")

TRACK_NAME = "moderator-direct"
TOPIC_TRANSCRIPTION = "lk.transcription"


class DirectSpeech:
    """What ``DirectVoice.play`` hands back. Offers the part of the session's
    SpeechHandle that the undo needs."""

    def __init__(self, task: asyncio.Task, stop: Callable[[], None]):
        self._task = task
        self._stop = stop
        self.interrupted = False

    def done(self) -> bool:
        return self._task.done()

    def interrupt(self, *, force: bool = False) -> "DirectSpeech":
        if not self._task.done():
            self.interrupted = True
            self._stop()
        return self


class DirectVoice:
    def __init__(self, room: rtc.Room):
        self._room = room
        self._source: rtc.AudioSource | None = None
        self._track_sid = ""
        self._task: asyncio.Task | None = None
        self._publishing = asyncio.Lock()

    @property
    def playing(self) -> bool:
        return self._task is not None and not self._task.done()

    async def _ensure_track(self, clip: Clip) -> rtc.AudioSource:
        async with self._publishing:
            if self._source is None:
                source = rtc.AudioSource(clip.sample_rate, clip.channels)
                track = rtc.LocalAudioTrack.create_audio_track(TRACK_NAME, source)
                publication = await self._room.local_participant.publish_track(
                    track,
                    # not "microphone": that is the track of the Live model, the
                    # one clients show as the moderator's voice
                    rtc.TrackPublishOptions(source=rtc.TrackSource.SOURCE_UNKNOWN),
                )
                self._source = source
                self._track_sid = publication.sid
            return self._source

    async def warm_up(self, clip: Clip) -> None:
        """Publishes the track ahead of the first use: it takes about a second."""
        try:
            await self._ensure_track(clip)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"could not publish the direct voice track: {e!r}")

    def play(
        self, clip: Clip, text: str, on_started: Callable[[], None] | None = None
    ) -> DirectSpeech | None:
        """Starts playing now. None if something is being played already."""
        if self.playing:
            return None
        self._task = asyncio.create_task(self._play(clip, text, on_started))
        return DirectSpeech(self._task, self.stop)

    def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        if self._source is not None:
            self._source.clear_queue()

    async def aclose(self) -> None:
        self.stop()
        if self._task is not None:
            await asyncio.gather(self._task, return_exceptions=True)

    async def _play(
        self, clip: Clip, text: str, on_started: Callable[[], None] | None
    ) -> None:
        try:
            source = await self._ensure_track(clip)
            if on_started is not None:
                on_started()
            await self._publish_transcript(text)
            async for frame in clip.frames():
                await source.capture_frame(frame)
            await source.wait_for_playout()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            logger.warning(f"direct playback failed: {e!r}")

    async def _publish_transcript(self, text: str) -> None:
        """What was said has to show up in the transcript like any other
        sentence of the moderator."""
        participant = self._room.local_participant
        segment_id = f"direct-{uuid.uuid4().hex[:10]}"
        try:
            await participant.send_text(
                text,
                topic=TOPIC_TRANSCRIPTION,
                attributes={
                    "lk.segment_id": segment_id,
                    "lk.transcribed_track_id": self._track_sid,
                    "lk.transcription_final": "true",
                },
            )
            # the web app still listens to the older transcription packets
            await participant.publish_transcription(
                rtc.Transcription(
                    participant_identity=participant.identity,
                    track_sid=self._track_sid,
                    segments=[
                        rtc.TranscriptionSegment(
                            id=segment_id,
                            text=text,
                            start_time=0,
                            end_time=0,
                            final=True,
                            language="zh",
                        )
                    ],
                )
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"could not publish the transcript of a clip: {e!r}")
