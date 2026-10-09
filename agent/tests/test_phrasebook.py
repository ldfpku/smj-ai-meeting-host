"""The wording of the meeting assistant: an aide who asks the chair, not a host
who orders the room."""

from phrasebook import (
    DEFAULT_CHAIR,
    INTERRUPTION_REASONS,
    call_name,
    chair_name,
    spoken_decision,
    spoken_interruption,
    spoken_missing_elements,
    spoken_no_outcome,
    spoken_open_item_without_owner,
    spoken_report_request,
    spoken_stance_request,
)

TITLE = "3 号注塑机良率下降原因分析"

#: how the old moderator talked; none of it may come back
OLD_STYLE = ("各位，先停一下", "表个态", "沉默", "强力", "裁判", "关闭证据", "议而不决")


def test_the_chair_is_called_by_the_web_apps_call_name_then_the_role_then_a_default():
    assert chair_name({"chairCallName": "李总", "chair": "总经理"}) == "李总"
    assert chair_name({"chair": "总经理"}) == "总经理"
    assert chair_name({"chairCallName": "  ", "chair": ""}) == DEFAULT_CHAIR
    assert chair_name(None) == DEFAULT_CHAIR


def test_an_attendee_is_called_by_call_name_then_name_then_role():
    assert call_name({"callName": "王部长", "name": "王建国", "role": "生产制造部部长"}) == "王部长"
    assert call_name({"name": "王建国", "role": "生产制造部部长"}) == "王建国"
    assert call_name({"role": "生产制造部部长"}) == "生产制造部部长"
    assert call_name({}) == ""


def test_the_interruption_is_asked_of_the_chair_not_ordered_of_the_room():
    text = spoken_interruption("3 号机良率下降", "unrelated_chitchat", "gentle", "李总")
    assert text == (
        "不好意思，打扰一下，李总，这个话题是否会后再聊？咱们先回到「3 号机良率下降」。"
    )
    assert "各位" not in text


def test_the_prompting_strength_changes_the_first_words():
    assert spoken_interruption("排产", style="strict", chair="李总").startswith("打扰一下，李总，")
    assert spoken_interruption("排产", style="gentle", chair="李总").startswith("不好意思，打扰一下，李总，")
    assert spoken_interruption("排产", style="concise", chair="李总") == "李总，是否先回到「排产」？"
    # a style saved by another build falls back to the default
    assert spoken_interruption("排产", style="?", chair="李总").startswith("打扰一下，李总，")


def test_every_reason_and_style_stays_short_and_names_the_topic():
    reasons = (*INTERRUPTION_REASONS, "")
    for style in ("strict", "gentle", "concise"):
        for reason in reasons:
            text = spoken_interruption(TITLE, reason, style, "生产制造部部长")
            assert f"「{TITLE}」" in text
            # about 5 characters a second; a clip over 12 seconds is a speech
            assert len(text) <= 60, text
            assert not any(old in text for old in OLD_STYLE), text


def test_an_unknown_reason_and_a_missing_title_still_make_a_sentence():
    assert spoken_interruption("", "whatever", "strict", "李总") == (
        "打扰一下，李总，是否先回到当前议题？"
    )


def test_missing_elements_are_asked_in_everyday_words_in_one_question():
    assert spoken_missing_elements(["责任人", "完成时限"], "李总") == (
        "李总，这项还需要确认：由谁牵头、几号前完成？"
    )
    text = spoken_missing_elements(["验证方式", "关闭证据"])
    assert text.startswith(DEFAULT_CHAIR)
    assert "关闭证据" not in text and "验证方式" not in text


def test_the_decision_is_read_back_plainly():
    assert spoken_decision("更换温控器。", "王部长", "本周五") == (
        "已记录决议：更换温控器。由王部长负责，本周五完成。"
    )


def test_an_item_left_without_outcome_is_pointed_out_to_the_chair():
    text = spoken_no_outcome("李总", 2, "下周排产计划")
    assert text == "李总，第 2 项「下周排产计划」还没有记录决议或未决事项，需要补记一下吗？"


def test_asking_somebody_to_speak_is_a_request_not_a_roll_call():
    assert spoken_report_request(["王部长"], "上月完成率") == "请王部长先介绍一下「上月完成率」的情况。"
    assert spoken_stance_request(["王部长"]) == "王部长，这一项您这边有什么意见？"
    assert spoken_stance_request(["王部长", "李部长"]) == "王部长、李部长，这一项想听听几位的意见。"
    assert spoken_open_item_without_owner() == "这条先记作未决事项，请问由谁会后牵头？"
    for text in (
        spoken_stance_request(["王部长"]),
        spoken_report_request(["王部长"], "X"),
        spoken_open_item_without_owner(),
    ):
        assert not any(old in text for old in OLD_STYLE), text
