import asyncio

import pytest

from speech_gate import SpeechGate, is_placeholder


def test_what_counts_as_a_placeholder():
    assert is_placeholder("<!-- This is a comment, no speech is generated -->") is True
    assert is_placeholder("（静默）") is True
    assert is_placeholder("  <no speech detected>") is True
    assert is_placeholder("...") is True
    assert is_placeholder("……") is True
    assert is_placeholder("各位，先停一下。") is False
    assert is_placeholder("“现在进入第 2 项") is False
    assert is_placeholder("  \n") is None
    assert is_placeholder("") is None


async def stream(items, gap=0.0):
    for item in items:
        if gap:
            await asyncio.sleep(gap)
        yield item


async def run(gate: SpeechGate, frames, chunks, text_delay=0.0, frame_gap=0.0):
    """Feeds one answer through the gate the way the framework does."""
    audio = gate.audio(stream(frames, frame_gap), seconds_of=lambda f: 0.1)

    async def delayed_text():
        await asyncio.sleep(text_delay)
        async for chunk in stream(chunks):
            yield chunk

    text = gate.text(delayed_text())

    async def collect(source):
        return [item async for item in source]

    return await asyncio.gather(collect(audio), collect(text))


@pytest.mark.asyncio
async def test_a_placeholder_is_dropped_with_its_sound():
    dropped = []
    gate = SpeechGate(on_dropped=dropped.append)
    gate.hold = 0.2
    audio, text = await run(
        gate,
        frames=list(range(20)),
        chunks=["<!-- This is a comment,", " no speech is generated -->"],
        text_delay=0.02,
        frame_gap=0.005,
    )
    assert audio == []
    assert text == []
    assert len(dropped) == 1
    assert dropped[0].dropped_seconds == pytest.approx(2.0)


@pytest.mark.asyncio
async def test_speech_passes_complete_and_in_order():
    gate = SpeechGate()
    gate.hold = 0.2
    audio, text = await run(
        gate,
        frames=list(range(20)),
        chunks=["各位，", "先停一下。"],
        text_delay=0.02,
        frame_gap=0.005,
    )
    assert audio == list(range(20))
    assert text == ["各位，", "先停一下。"]


@pytest.mark.asyncio
async def test_a_short_answer_waits_for_its_text():
    gate = SpeechGate()
    gate.hold = 0.3
    # the audio is complete at once, the text says later that it is nothing
    audio, text = await run(gate, frames=[1, 2, 3], chunks=["（静默）"], text_delay=0.1)
    assert audio == []
    assert text == []


@pytest.mark.asyncio
async def test_late_text_does_not_hold_speech_back_for_long():
    gate = SpeechGate()
    gate.hold = 0.05
    audio, text = await run(
        gate,
        frames=list(range(30)),
        chunks=["现在进入第 2 项。"],
        text_delay=0.2,
        frame_gap=0.01,
    )
    assert audio == list(range(30))
    assert text == ["现在进入第 2 项。"]


@pytest.mark.asyncio
async def test_a_late_placeholder_still_cuts_the_rest():
    gate = SpeechGate()
    gate.hold = 0.05
    audio, text = await run(
        gate,
        frames=list(range(30)),
        chunks=["<!-- nothing -->"],
        text_delay=0.15,
        frame_gap=0.01,
    )
    # what was let out before the text came cannot be taken back
    assert 0 < len(audio) < 30
    assert text == []


@pytest.mark.asyncio
async def test_answers_do_not_mix():
    gate = SpeechGate()
    gate.hold = 0.2
    first = await run(gate, frames=[1, 2], chunks=["（静默）"], text_delay=0.01)
    second = await run(gate, frames=[3, 4], chunks=["请王部长先介绍情况。"], text_delay=0.01)
    assert first == [[], []]
    assert second == [[3, 4], ["请王部长先介绍情况。"]]


@pytest.mark.asyncio
async def test_text_without_audio_passes():
    gate = SpeechGate()
    text = gate.text(stream(["只有文字的回答"]))
    assert [chunk async for chunk in text] == ["只有文字的回答"]


@pytest.mark.asyncio
async def test_the_text_may_be_read_before_the_audio():
    gate = SpeechGate()
    gate.hold = 0.2
    audio = gate.audio(stream([1, 2, 3]), seconds_of=lambda f: 0.1)
    text = gate.text(stream(["（静默）"]))
    assert [chunk async for chunk in text] == []
    assert [frame async for frame in audio] == []


@pytest.mark.asyncio
async def test_an_unwanted_answer_is_dropped_and_the_next_one_is_not():
    gate = SpeechGate()
    gate.hold = 0.1
    gate.drop_next()
    first = await run(gate, frames=[1, 2], chunks=["系统会替你宣布，你保持静默。"])
    second = await run(gate, frames=[3, 4], chunks=["请王部长先介绍情况。"])
    assert first == [[], []]
    assert second == [[3, 4], ["请王部长先介绍情况。"]]


@pytest.mark.asyncio
async def test_an_answer_without_sound_does_not_use_the_drop_up():
    gate = SpeechGate()
    gate.hold = 0.1
    gate.drop_next()
    silent = await run(gate, frames=[], chunks=[])
    spoken = await run(gate, frames=[1, 2], chunks=["系统会替你宣布，你保持静默。"])
    assert silent == [[], []]
    assert spoken == [[], []]


@pytest.mark.asyncio
async def test_a_drop_can_be_called_off():
    gate = SpeechGate()
    gate.hold = 0.1
    gate.drop_next()
    gate.keep_next()
    assert await run(gate, frames=[1, 2], chunks=["请王部长表个态。"]) == [[1, 2], ["请王部长表个态。"]]


def test_a_chinese_moderator_does_not_speak_english():
    text = chr(0x200B) + chr(10) + "I will not provide any output."
    assert is_placeholder(text) is False
    assert is_placeholder(text, chinese=True) is True
    # too short to tell, until it is known to be all there is
    assert is_placeholder("OK", chinese=True) is None
    assert is_placeholder("OK", chinese=True, complete=True) is True
    # names and numbers at the start are fine
    assert is_placeholder("3 号注塑机的良率", chinese=True) is False
    assert is_placeholder("PMC 留档之后再谈", chinese=True) is False
    assert is_placeholder("“现在进入第 2 项", chinese=True) is False


@pytest.mark.asyncio
async def test_an_english_aside_is_dropped_in_a_chinese_meeting():
    gate = SpeechGate(chinese=True)
    gate.hold = 0.2
    audio, text = await run(
        gate,
        frames=list(range(10)),
        chunks=[chr(0x200B) + chr(10), "I will not ", "provide any output."],
        text_delay=0.01,
        frame_gap=0.005,
    )
    assert audio == []
    assert text == []


@pytest.mark.asyncio
async def test_text_that_starts_with_a_number_is_kept_whole():
    gate = SpeechGate(chinese=True)
    gate.hold = 0.2
    audio, text = await run(
        gate, frames=[1, 2, 3], chunks=["3 ", "号机的", "温控器"], text_delay=0.01
    )
    assert audio == [1, 2, 3]
    assert "".join(text) == "3 号机的温控器"
