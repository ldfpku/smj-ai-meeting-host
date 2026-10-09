"""What the meeting assistant (会议助手) says, word for word.

The assistant is the chair's aide, not the host: it asks the chair rather than
orders the room, and it addresses people the way a Chinese factory meeting does
("李总", "王部长", "您"). Every fixed sentence lives here so that the tone is
decided in one place and can be tested.

How people are called is worked out on the web side (``callName`` of every
attendee, ``chairCallName`` of the chair; see web/src/data/honorifics.ts) and
arrives in the meeting config. Without it the role is used, and finally
"主持人".

Kept free of livekit imports so it can be unit-tested on its own.
"""

from __future__ import annotations

DEFAULT_CHAIR = "主持人"


def chair_name(meeting_config: dict | None) -> str:
    """How the assistant addresses the chair."""
    cfg = meeting_config or {}
    for key in ("chairCallName", "chair"):
        value = cfg.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return DEFAULT_CHAIR


def call_name(attendee: dict) -> str:
    """How an attendee is called: 李总, 王部长, else the name, else the role."""
    for key in ("callName", "name", "role"):
        value = attendee.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


# -- interrupting a digression --------------------------------------------

#: What is said first, by prompting strength (``style`` in the meeting config:
#: strict = 积极, gentle = 标准, concise = 精简). Everyday words only.
_OPENERS: dict[str, str] = {
    "strict": "打扰一下，",
    "gentle": "不好意思，打扰一下，",
}
#: The line, by the reason Jev picked. ``{topic}`` is the agenda title and
#: ``{chair}`` the chair: the assistant asks the chair, and the room hears it.
_REDIRECTS: dict[str, str] = {
    "unrelated_chitchat": "{chair}，这个话题是否会后再聊？咱们先回到{topic}。",
    "other_agenda_item": "{chair}，这件事是否放到后面的议题再谈？咱们先把{topic}谈完。",
    "side_issue": "{chair}，这个细节是否会后再议？咱们先回到{topic}的主要问题。",
    "argument": "{chair}，这一点是否先放一放？咱们先回到{topic}，把结论定下来。",
}
INTERRUPTION_REASONS = tuple(_REDIRECTS)
_DEFAULT_REDIRECT = "{chair}，是否先回到{topic}？"


def spoken_interruption(
    title: str,
    reason_code: str = "",
    style: str = "strict",
    chair: str = DEFAULT_CHAIR,
) -> str:
    """The words that bring the meeting back on topic, asked of the chair.

    One short sentence pair, about 7 seconds of speech. The goal of the agenda
    item and the reason are left out on purpose: both are on the kanban.
    """
    title = (title or "").strip()
    topic = f"「{title}」" if title else "当前议题"
    chair = (chair or DEFAULT_CHAIR).strip()
    opener = "" if style == "concise" else _OPENERS.get(style, _OPENERS["strict"])
    redirect = _REDIRECTS.get(reason_code, _DEFAULT_REDIRECT)
    return opener + redirect.format(topic=topic, chair=chair)


# -- decisions and open items ----------------------------------------------

#: The four elements as people say them, not as the form names them.
_MISSING_PHRASES = {
    "责任人": "由谁牵头",
    "完成时限": "几号前完成",
    "验证方式": "怎么验证做到了",
    "关闭证据": "留什么记录作为依据",
}


def spoken_missing_elements(missing: list[str], chair: str = DEFAULT_CHAIR) -> str:
    """A decision lacks some of its elements: one question, to the chair."""
    asked = "、".join(_MISSING_PHRASES.get(m, m) for m in missing)
    return f"{(chair or DEFAULT_CHAIR).strip()}，这项还需要确认：{asked}？"


def spoken_decision(decision: str, owner: str, due: str) -> str:
    return f"已记录决议：{decision.rstrip('。')}。由{owner}负责，{due}完成。"


def spoken_open_item(owner: str, escalate_to: str) -> str:
    """What the assistant says after recording an open item.

    The escalation path is a phrase of its own ("提请总经理签批并留档"), so it
    is not put behind "上报到": the model stumbled over that and was heard
    saying 总理 for 总经理.
    """
    path = (escalate_to or "").strip().rstrip("。")
    who = owner or "相关责任人"
    sentence = f"这条今天先不拍板，记作未决事项，由{who}会后牵头。"
    if not path:
        return sentence
    if path.startswith(("提请", "上报", "报", "提交", "交")) and "；" not in path:
        return sentence + f"会后{path}。"
    return sentence + f"上报路径是：{path}。"


def spoken_open_item_owner(owner: str) -> str:
    """Said when an open item was announced and somebody else is to follow it up."""
    return f"更正一下：这条未决事项由{owner}会后牵头。"


def spoken_open_item_without_owner() -> str:
    return "这条先记作未决事项，请问由谁会后牵头？"


def spoken_no_outcome(chair: str, number: int, title: str) -> str:
    """The agenda moved on, and the item it left has neither decision nor open item."""
    return (
        f"{(chair or DEFAULT_CHAIR).strip()}，第 {number} 项「{title}」"
        "还没有记录决议或未决事项，需要补记一下吗？"
    )


# -- summary -------------------------------------------------------------


def spoken_summary(
    decisions: list[dict],
    open_items: list[dict],
    incomplete: int = 0,
) -> str:
    """The summary asked for by the chair. Put together here and not by the
    model: the numbers are right, and it is said in the prepared voice.

    It does not close the meeting: that is the chair's to say.
    """
    parts = []
    if decisions:
        parts.append(
            f"本次会议共记录 {len(decisions)} 条决议"
            + (f"，其中 {incomplete} 条信息还不齐全" if incomplete else "，信息都齐全")
        )
    else:
        parts.append("本次会议没有记录决议")
    if open_items:
        owners = list(dict.fromkeys(o.get("owner") for o in open_items if o.get("owner")))
        parts.append(
            f"另有 {len(open_items)} 条未决事项"
            + (f"，由{'、'.join(owners)}会后跟进" if owners else "")
        )
    else:
        parts.append("没有未决事项")
    return "；".join(parts) + "。以上是会议助手的记录，请主持人确认。"


# -- asking somebody to speak (only when the chair wants it) ---------------


def spoken_report_request(who: list[str], title: str) -> str:
    return f"请{'、'.join(who)}先介绍一下「{title}」的情况。"


def spoken_stance_request(who: list[str]) -> str:
    if len(who) == 1:
        return f"{who[0]}，这一项您这边有什么意见？"
    return f"{'、'.join(who)}，这一项想听听几位的意见。"
