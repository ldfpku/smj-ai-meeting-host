"""Sentences the moderator has ready before it needs them.

The Live model speaks when the room pauses: told to interrupt somebody who
is in the middle of a long digression, it waits until that person is done.
An interruption has to come while the person is talking, so the sentence is
synthesised ahead of time, in the voice of the moderator, and played by the
agent itself the moment the digression is detected.

This works because the wording of an interruption is fixed
(``intervention.spoken_interruption``) and known as soon as the agenda item is.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import wave
from io import BytesIO
from typing import AsyncIterator

import httpx
from livekit import rtc

logger = logging.getLogger("gemini-playground")

TTS_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/interactions"
DEFAULT_TTS_MODEL = "gemini-3.8-flash-tts"
FRAME_MS = 20


class Clip:
    def __init__(self, pcm: bytes, sample_rate: int, channels: int):
        self.pcm = pcm
        self.sample_rate = sample_rate
        self.channels = channels

    @property
    def seconds(self) -> float:
        return len(self.pcm) / 2 / self.channels / self.sample_rate

    async def frames(self) -> AsyncIterator[rtc.AudioFrame]:
        samples = self.sample_rate * FRAME_MS // 1000
        size = samples * 2 * self.channels
        for start in range(0, len(self.pcm), size):
            chunk = self.pcm[start : start + size]
            if len(chunk) < size:
                chunk += bytes(size - len(chunk))
            yield rtc.AudioFrame(chunk, self.sample_rate, self.channels, samples)


def clip_from_wav(data: bytes) -> Clip:
    with wave.open(BytesIO(data), "rb") as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"unsupported sample width: {w.getsampwidth()}")
        return Clip(w.readframes(w.getnframes()), w.getframerate(), w.getnchannels())


class SpokenClips:
    """Synthesises sentences in the background and hands them out by text."""

    def __init__(self, api_key: str, voice: str, model: str | None = None):
        self._api_key = api_key
        self._voice = voice
        self._model = (
            model or os.environ.get("GEMINI_TTS_MODEL", "").strip() or DEFAULT_TTS_MODEL
        )
        self._clips: dict[str, Clip] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._client: httpx.AsyncClient | None = None

    def prepare(self, texts: list[str]) -> None:
        for text in dict.fromkeys(texts):
            if text and text not in self._clips and text not in self._tasks:
                self._tasks[text] = asyncio.create_task(self._synthesize(text))

    def get(self, text: str) -> Clip | None:
        return self._clips.get(text)

    async def aclose(self) -> None:
        tasks, self._tasks = list(self._tasks.values()), {}
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _synthesize(self, text: str) -> None:
        try:
            if self._client is None:
                self._client = httpx.AsyncClient(timeout=60)
            response = await self._client.post(
                TTS_ENDPOINT,
                headers={"x-goog-api-key": self._api_key},
                json={
                    "model": self._model,
                    "input": text,
                    "response_format": {"type": "audio"},
                    "generation_config": {"speech_config": [{"voice": self._voice}]},
                },
            )
            response.raise_for_status()
            data = None
            for step in response.json().get("steps", []):
                for part in step.get("content") or []:
                    if part.get("type") == "audio" and part.get("data"):
                        data = base64.b64decode(part["data"])
            if not data:
                raise ValueError("no audio in the response")
            self._clips[text] = clip_from_wav(data)
            logger.info(f"clip ready ({self._clips[text].seconds:.1f}s): {text}")
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            # the moderator then says it through the Live model, as before
            logger.warning(f"could not prepare a clip, falling back to the model: {e!r}")
        finally:
            self._tasks.pop(text, None)
