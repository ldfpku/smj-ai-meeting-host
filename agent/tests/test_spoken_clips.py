import io
import wave

import pytest

from direct_voice import DirectSpeech
from spoken_clips import clip_from_wav


def make_wav(seconds: float, rate: int = 24000) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(int(rate * seconds) * 2))
    return buffer.getvalue()


async def test_a_clip_is_cut_into_20_ms_frames():
    clip = clip_from_wav(make_wav(0.11))

    assert clip.sample_rate == 24000
    assert clip.seconds == pytest.approx(0.11)

    frames = [frame async for frame in clip.frames()]
    # the last, shorter piece is padded to a full frame
    assert len(frames) == 6
    assert all(frame.samples_per_channel == 480 for frame in frames)
    assert all(frame.sample_rate == 24000 for frame in frames)


async def test_stopping_a_direct_speech_marks_it_interrupted():
    import asyncio

    stopped = []
    task = asyncio.create_task(asyncio.sleep(10))
    speech = DirectSpeech(task, lambda: (stopped.append(True), task.cancel()))

    assert not speech.done()
    speech.interrupt(force=True)
    await asyncio.gather(task, return_exceptions=True)

    assert stopped == [True]
    assert speech.interrupted
    assert speech.done()
