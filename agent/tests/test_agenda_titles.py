import main


def make_manager() -> main.SessionManager:
    config = main.parse_session_config(
        {
            "model": "gemini-3.8-live",
            "meeting_config": {
                "agendas": [
                    {"title": "3 号注塑机良率下降原因分析", "goal": "确定根因"},
                    {"title": "下周排产计划", "goal": "确认排产顺序"},
                ]
            },
        }
    )
    return main.SessionManager(config)


def test_the_model_spelling_is_mapped_to_the_configured_title():
    manager = make_manager()

    # the model tends to drop or add the space between digits and characters
    assert (
        manager.canonical_agenda_title("3号注塑机良率下降原因分析")
        == "3 号注塑机良率下降原因分析"
    )
    assert manager.canonical_agenda_title(" 下周 排产计划 ") == "下周排产计划"


def test_no_title_means_the_current_agenda_item():
    manager = make_manager()

    assert manager.canonical_agenda_title(None) == "3 号注塑机良率下降原因分析"
    manager.current_agenda_index = 1
    assert manager.canonical_agenda_title("") == "下周排产计划"


def test_an_unknown_title_is_kept():
    manager = make_manager()

    assert manager.canonical_agenda_title("临时动议") == "临时动议"


def test_a_decision_counts_for_its_agenda_whatever_the_spelling():
    manager = make_manager()

    # recorded by an older build, under the spelling the model used
    manager.decisions.append({"agendaTitle": "3号注塑机良率下降原因分析", "decision": "换温控器"})
    manager.open_items.append({"agendaTitle": "3号 注塑机良率下降原因分析", "issue": "备件"})

    assert len(manager.decisions_for_current_agenda()) == 1
    assert len(manager.open_items_for_current_agenda()) == 1


def test_removed_model_falls_back_in_the_session_config():
    config = main.parse_session_config(
        {"model": "gemini-2.5-flash-native-audio-preview-12-2025"}
    )
    assert config.model == "gemini-3.8-live"


def test_intervention_settings_do_not_change_the_session_fingerprint():
    base = {
        "model": "gemini-3.8-live",
        "instructions": "x",
        "meeting_config": {"topic": "t", "agendas": [], "intervention": {"mode": "auto"}},
    }
    changed = {
        **base,
        "meeting_config": {
            **base["meeting_config"],
            "intervention": {"mode": "semi_auto", "threshold": 0.9},
        },
    }
    a = main.parse_session_config(base)
    b = main.parse_session_config(changed)

    assert a != b
    assert a.session_fingerprint() == b.session_fingerprint()


def test_the_servers_key_wins_over_the_browsers(monkeypatch):
    monkeypatch.setenv("GEMINI_API_KEY", "server-key")
    assert main.resolve_gemini_key("browser-key") == "server-key"

    monkeypatch.delenv("GEMINI_API_KEY")
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    assert main.resolve_gemini_key("browser-key") == "browser-key"
    assert main.resolve_gemini_key(None) == ""


def test_config_payload_is_redacted_for_the_log():
    shown = main.redact_config_payload(
        '{"gemini_api_key": "secret", "instructions": "long prompt", "model": "m"}'
    )
    assert "secret" not in shown
    assert "long prompt" not in shown
    assert '"model": "m"' in shown


def test_the_interruption_cue_carries_the_exact_words():
    manager = make_manager()
    manager.current_config.meeting_config["style"] = "gentle"

    cue = manager.intervention_prompt("argument")

    assert cue.startswith("【打断指令】")
    assert (
        "“不好意思，打扰一下，主持人，这一点是否先放一放？"
        "咱们先回到「3 号注塑机良率下降原因分析」，把结论定下来。”" in cue
    )
    # the goal of the agenda item is not read aloud any more
    assert "确定根因" not in cue


def test_the_same_open_item_in_other_words_is_recognised():
    # both were recorded for one matter within ten seconds of a simulated meeting
    first = "下周排产计划无法确定" + "原料到货时间供应商尚未确认"
    second = "下周排产顺序待定" + "原料到货时间供应商未确认"
    assert main.same_matter(first, second)

    other = "3 号机备件采购预算超支" + "需要财务部核对上季度的付款记录"
    assert not main.same_matter(first, other)
    assert not main.same_matter("", second)


def test_a_settled_item_asks_to_move_on_instead_of_interrupting():
    manager = make_manager()
    assert manager.move_on_prompt() is None  # nothing decided yet: a real digression

    manager.decisions.append({"agendaTitle": "3号注塑机良率下降原因分析", "decision": "换温控器"})
    prompt = manager.move_on_prompt()
    assert prompt.startswith("【推进指令】")
    assert "advance_agenda" in prompt

    # nobody is chased for a statement any more: the cue only moves the agenda
    assert "request_speaker" not in prompt
    assert "不需要口头宣布" in prompt


def test_the_chair_is_addressed_by_the_name_the_web_app_worked_out():
    manager = make_manager()
    assert manager.chair_call() == "主持人"

    manager.current_config.meeting_config["chair"] = "总经理"
    assert manager.chair_call() == "总经理"

    manager.current_config.meeting_config["chairCallName"] = "李总"
    assert manager.chair_call() == "李总"
    assert "李总，这一点是否先放一放？" in manager.intervention_prompt("argument")
