from main import same_open_item, spoken_open_item, spoken_summary

NOW = 1_000_000


def known(issue: str, reason: str = "", age_ms: int = 10_000) -> dict:
    return {"issue": issue, "reason": reason, "timestamp": NOW - age_ms, "updatedAt": NOW - age_ms}


def test_the_same_matter_in_other_words_is_one_item():
    # both pairs were recorded twice in a simulated meeting
    assert same_open_item(
        "下月交付优先级（新疆客户与租赁池补货的先后顺序）",
        "缺新疆客户的书面确认到货期限",
        known("下月交付优先级（新疆客户裸杆 vs 租赁池补套）无法确定", "进口阀座供应商未书面确认到货期限"),
        NOW,
    )
    assert same_open_item(
        "下月订单交付优先级无法确定，产能只够先做一个",
        "客户未书面确认",
        known("确定新疆客户与租赁池订单的下月交付优先级", "缺客户确认"),
        NOW,
    )


def test_another_matter_is_another_item():
    assert not same_open_item(
        "三号机模温机备件采购预算没有批",
        "预算未批",
        known("原料到货时间未确认，排产顺序定不下来", "供应商没有确认"),
        NOW,
    )


def test_words_in_another_order_only_count_shortly_after():
    issue = "下月订单交付优先级无法确定，产能只够先做一个"
    before = "确定新疆客户与租赁池订单的下月交付优先级"
    assert same_open_item(issue, "", known(before, age_ms=60_000), NOW)
    assert not same_open_item(issue, "", known(before, age_ms=600_000), NOW)


def test_the_announcement_reads_like_a_sentence():
    assert spoken_open_item("赵部长", "提请总经理签批并留档") == (
        "这条今天先不拍板，记作未决事项，由赵部长会后牵头。会后提请总经理签批并留档。"
    )
    # a path that is a rule in itself is quoted, not woven into the sentence
    assert spoken_open_item("", "优先级冲突由本会裁决；临时插单由总经理签批，PMC 留档") == (
        "这条今天先不拍板，记作未决事项，由相关责任人会后牵头。"
        "上报路径是：优先级冲突由本会裁决；临时插单由总经理签批，PMC 留档。"
    )
    assert spoken_open_item("赵部长", "") == "这条今天先不拍板，记作未决事项，由赵部长会后牵头。"


def test_the_summary_counts_what_is_on_the_board():
    full = {"owner": "李工", "dueDate": "周五", "verification": "良率", "evidence": "报表"}
    part = {"owner": "李工", "dueDate": "", "verification": "", "evidence": ""}
    assert spoken_summary([full], [{"owner": "陈主管"}]) == (
        "本次会议共记录 1 条决议，信息都齐全；另有 1 条未决事项，由陈主管会后跟进。"
        "以上是会议助手的记录，请主持人确认。"
    )
    assert spoken_summary([full, part], []) == (
        "本次会议共记录 2 条决议，其中 1 条信息还不齐全；没有未决事项。"
        "以上是会议助手的记录，请主持人确认。"
    )
    assert spoken_summary([], []).startswith("本次会议没有记录决议；没有未决事项。")
