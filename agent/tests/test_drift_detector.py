import asyncio

from drift_detector import DriftDetector, DriftJudgment, DriftResult
from intervention import InterventionSettings

CONTEXT = {
    "meeting_topic": "月度产销协同会",
    "current_agenda": {"title": "3 号机良率下降", "goal": "确定根因并指定整改负责人"},
    "other_agenda_titles": ["下月排产计划"],
}

ON_TOPIC = "三号机上周良率从百分之九十六掉到九十一，我怀疑是模温控制不稳"
OFF_TOPIC = "说到这个，下个月公司团建大家想去哪，我觉得去海边不错"


class StubJudge:
    """Returns the queued judgments in order; the last one repeats."""

    def __init__(self, *probabilities: float, level: float = 3.0, delay: float = 0.0):
        self.probabilities = list(probabilities)
        self.level = level
        self.delay = delay
        self.states: list[dict] = []
        self.in_flight = 0
        self.max_in_flight = 0
        self.error: Exception | None = None
        self.closed = False

    async def judge(self, state: dict) -> DriftJudgment:
        self.states.append(state)
        self.in_flight += 1
        self.max_in_flight = max(self.max_in_flight, self.in_flight)
        try:
            if self.delay:
                await asyncio.sleep(self.delay)
            if self.error is not None:
                raise self.error
            index = min(len(self.states) - 1, len(self.probabilities) - 1)
            probability = self.probabilities[index]
            return DriftJudgment(
                probability=probability,
                level=self.level if probability >= 0.5 else 0.0,
                reason_code="unrelated_chitchat" if probability >= 0.5 else "none",
                elapsed_ms=int(self.delay * 1000),
            )
        finally:
            self.in_flight -= 1

    async def aclose(self) -> None:
        self.closed = True


def make_detector(judge: StubJudge, settings: InterventionSettings | None = None):
    settings = settings or InterventionSettings()
    drifts: list[DriftResult] = []
    judgments: list[DriftJudgment] = []

    async def on_drift(result: DriftResult) -> None:
        drifts.append(result)

    async def on_judgment(judgment: DriftJudgment) -> None:
        judgments.append(judgment)

    detector = DriftDetector(
        judge,
        get_context=lambda: CONTEXT,
        get_settings=lambda: settings,
        on_drift=on_drift,
        on_judgment=on_judgment,
        stable_seconds=0.02,
        growth_chars=15,
        min_interval_seconds=0.0,
    )
    return detector, drifts, judgments


async def settle(detector: DriftDetector) -> None:
    for _ in range(200):
        runner = detector._runner
        if runner is None or runner.done():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("detector did not settle")


async def test_on_topic_discussion_is_left_alone():
    judge = StubJudge(0.02)
    detector, drifts, judgments = make_detector(judge)

    detector.on_transcript("item-1", ON_TOPIC)
    await settle(detector)

    assert drifts == []
    assert len(judgments) == 1
    assert judge.states[0]["latest_remarks"] == ON_TOPIC
    assert judge.states[0]["current_agenda"]["title"] == "3 号机良率下降"


async def test_single_hit_above_threshold_triggers():
    judge = StubJudge(0.9)
    detector, drifts, _ = make_detector(judge, InterventionSettings(threshold=0.85))

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)

    assert len(drifts) == 1
    assert drifts[0].judgment.probability == 0.9
    assert drifts[0].reason == "无关闲聊"
    assert drifts[0].transcript_at > 0


async def test_below_threshold_does_not_trigger():
    judge = StubJudge(0.8)
    detector, drifts, _ = make_detector(judge, InterventionSettings(threshold=0.85))

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)

    assert drifts == []


async def test_low_drift_level_does_not_trigger():
    # a related side issue: probable, but not far enough from the topic
    judge = StubJudge(0.9, level=1.5)
    detector, drifts, _ = make_detector(judge, InterventionSettings(threshold=0.85))

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)

    assert drifts == []


async def test_consecutive_hits_are_required():
    judge = StubJudge(0.9, 0.9)
    detector, drifts, _ = make_detector(
        judge, InterventionSettings(threshold=0.85, consecutive_hits=2)
    )

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)
    assert drifts == []

    detector.on_transcript("item-1", OFF_TOPIC + "，顺便吃海鲜")
    await settle(detector)
    assert len(drifts) == 1
    assert drifts[0].hits == 2


async def test_a_miss_resets_the_hit_counter():
    judge = StubJudge(0.9, 0.1, 0.9)
    detector, drifts, _ = make_detector(
        judge, InterventionSettings(threshold=0.85, consecutive_hits=2)
    )

    for i, text in enumerate((OFF_TOPIC, ON_TOPIC, OFF_TOPIC)):
        detector.on_transcript(f"item-{i}", text)
        await settle(detector)

    assert drifts == []


async def test_fast_path_ignores_consecutive_hits():
    judge = StubJudge(0.99)
    detector, drifts, _ = make_detector(
        judge, InterventionSettings(threshold=0.85, consecutive_hits=3)
    )

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)

    assert len(drifts) == 1


async def test_single_flight_and_latest_text_wins():
    judge = StubJudge(0.02, delay=0.1)
    detector, _, _ = make_detector(judge)

    detector.on_transcript("item-1", ON_TOPIC)
    await asyncio.sleep(0.05)  # first judgment is in the air
    for suffix in ("，李工", "，李工你查一下", "，李工你查一下记录"):
        detector.on_transcript("item-1", ON_TOPIC + suffix)
    await settle(detector)

    assert judge.max_in_flight == 1
    assert len(judge.states) == 2
    assert judge.states[-1]["latest_remarks"].endswith("李工你查一下记录")


async def test_interim_updates_replace_the_same_item():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)

    detector.on_transcript("item-1", "三号机上周")
    detector.on_transcript("item-1", "三号机上周良率下降")
    detector.on_transcript("item-2", "我查了模温记录")
    await settle(detector)

    latest, earlier, _ = detector.window()
    assert latest == "三号机上周良率下降\n我查了模温记录"
    assert earlier == ""


async def test_judge_failure_fails_open():
    judge = StubJudge(0.99)
    judge.error = asyncio.TimeoutError()
    detector, drifts, judgments = make_detector(judge)

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)

    assert drifts == []
    assert judgments == []

    # and it recovers on the next update
    judge.error = None
    detector.on_transcript("item-1", OFF_TOPIC + "，顺便吃海鲜")
    await settle(detector)
    assert len(drifts) == 1


async def test_judged_text_does_not_trigger_again():
    judge = StubJudge(0.99)
    detector, drifts, _ = make_detector(judge)

    detector.on_transcript("item-1", OFF_TOPIC)
    await settle(detector)
    assert len(drifts) == 1

    # the same cumulative item keeps growing after the interruption
    detector.on_transcript("item-1", OFF_TOPIC + "好的我们回到良率的问题上来")
    await settle(detector)

    assert judge.states[-1]["latest_remarks"] == "好的我们回到良率的问题上来"
    assert judge.states[-1]["earlier_remarks"] == ""


async def test_short_fragments_are_not_judged():
    judge = StubJudge(0.99)
    detector, drifts, _ = make_detector(judge)

    detector.on_transcript("item-1", "嗯好的")
    await settle(detector)

    assert judge.states == []
    assert drifts == []


async def test_window_keeps_only_the_tail_of_a_long_monologue():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)

    detector.on_transcript("item-1", "甲" * 900 + "最后一句")
    await settle(detector)

    text = judge.states[0]["latest_remarks"]
    assert len(text) == 400
    assert text.endswith("最后一句")


async def test_only_the_latest_remarks_are_judged():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)
    detector._recent_seconds = 0.2
    detector._latest_min_chars = 20

    # the moderator stays silent, so the whole discussion is one growing item
    detector.on_transcript("item-1", ON_TOPIC)
    await settle(detector)
    await asyncio.sleep(0.3)
    detector.on_transcript("item-1", ON_TOPIC + OFF_TOPIC)
    await settle(detector)

    assert judge.states[-1]["latest_remarks"] == OFF_TOPIC
    assert judge.states[-1]["earlier_remarks"] == ON_TOPIC


async def test_short_remarks_are_topped_up_with_what_came_before():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)
    detector._recent_seconds = 0.2

    detector.on_transcript("item-1", ON_TOPIC)
    await settle(detector)
    await asyncio.sleep(0.3)
    detector.on_transcript("item-2", "对，我同意，就这么办吧")
    await settle(detector)

    assert judge.states[-1]["latest_remarks"] == ON_TOPIC + "\n对，我同意，就这么办吧"


async def test_a_revised_interim_transcript_replaces_the_old_one():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)

    detector.on_transcript("item-1", "三号鸡上周凉率")
    detector.on_transcript("item-1", "三号机上周良率下降了五个点")
    await settle(detector)

    latest, _, _ = detector.window()
    assert latest == "三号机上周良率下降了五个点"


async def test_spaces_between_chinese_characters_are_removed():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)

    # what gemini-3.1 delivers; the space next to Latin text has to stay
    detector.on_transcript("item-1", "三 号 机 的 mold temperature 波 动 超 过 了 5 度")
    await settle(detector)

    assert (
        judge.states[0]["latest_remarks"]
        == "三号机的 mold temperature 波动超过了 5 度"
    )


async def test_aclose_closes_the_judge():
    judge = StubJudge(0.02, delay=0.2)
    detector, _, _ = make_detector(judge)

    detector.on_transcript("item-1", ON_TOPIC)
    await asyncio.sleep(0.05)
    await detector.aclose()

    assert judge.closed is True
    detector.on_transcript("item-2", OFF_TOPIC)
    assert detector._runner.done()


async def test_a_digression_is_not_diluted_by_the_previous_speaker():
    judge = StubJudge(0.02)
    detector, _, _ = make_detector(judge)

    # streaming recognition: one item per utterance, a few seconds apart
    detector.on_transcript("fast-0", ON_TOPIC)
    await settle(detector)
    detector.on_transcript("fast-1", OFF_TOPIC)
    await settle(detector)

    assert judge.states[-1]["latest_remarks"] == OFF_TOPIC
    assert judge.states[-1]["earlier_remarks"] == ON_TOPIC


async def test_a_judgment_that_contradicts_itself_does_not_interrupt():
    # seen in a simulated meeting: "请主持人做个总结" came back as p=0.88, reason "none"
    judge = StubJudge(0.99)
    detector, drifts, judgments = make_detector(judge)

    async def contradictory(state: dict) -> DriftJudgment:
        return DriftJudgment(probability=0.99, level=3.0, reason_code="none", elapsed_ms=1)

    judge.judge = contradictory
    detector.on_transcript("item-1", "今天的议题都讨论完了，请主持人做个总结，然后结束会议")
    await settle(detector)

    assert len(judgments) == 1
    assert drifts == []
