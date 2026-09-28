from meeting_limits import IDLE, LIMIT, End, LimitWatch, MeetingLimits, Notice


def watch(**limits) -> LimitWatch:
    return LimitWatch(MeetingLimits(**limits), now=0.0)


def test_allowed_length_follows_the_plan(monkeypatch):
    monkeypatch.delenv("MEETING_MAX_MINUTES", raising=False)
    monkeypatch.delenv("MEETING_IDLE_MINUTES", raising=False)
    assert MeetingLimits.for_meeting(60).max_seconds == 120 * 60
    # a short meeting gets half an hour on top, not just its length again
    assert MeetingLimits.for_meeting(3).max_seconds == 33 * 60
    # and no plan allows more than the ceiling
    assert MeetingLimits.for_meeting(200).max_seconds == 240 * 60
    assert MeetingLimits.for_meeting(None).max_seconds == 240 * 60


def test_limits_can_be_set_in_the_environment(monkeypatch):
    monkeypatch.setenv("MEETING_MAX_MINUTES", "45")
    monkeypatch.setenv("MEETING_IDLE_MINUTES", "2")
    limits = MeetingLimits.for_meeting(60)
    assert limits.max_seconds == 45 * 60
    assert limits.idle_seconds == 120


def test_a_silent_room_is_warned_and_then_closed():
    w = watch(idle_seconds=600, idle_grace_seconds=60, max_seconds=7200)
    assert w.check(599) is None
    assert w.check(600) == Notice(IDLE, 60)
    # the notice is given once
    assert w.check(630) is None
    assert w.check(660) == End(IDLE)


def test_speaking_calls_the_ending_off():
    w = watch(idle_seconds=600, idle_grace_seconds=60, max_seconds=7200)
    assert isinstance(w.check(600), Notice)
    assert w.heard(620) is True
    assert w.check(700) is None
    # and the silence is counted from that remark
    assert w.check(1219) is None
    assert w.check(1220) == Notice(IDLE, 60)
    assert w.heard(1225) is True
    assert w.heard(1230) is False


def test_a_meeting_ends_at_its_limit_even_if_people_talk():
    w = watch(idle_seconds=600, max_seconds=3600, limit_notice_seconds=300)
    for t in range(0, 3300, 60):
        w.heard(t)
        assert w.check(t) is None
    w.heard(3300)
    assert w.check(3300) == Notice(LIMIT, 300)
    w.heard(3500)
    assert w.check(3500) is None
    assert w.check(3600) == End(LIMIT)


def test_an_extension_moves_the_limit():
    w = watch(idle_seconds=600, max_seconds=3600, limit_notice_seconds=300, extension_seconds=1800)
    assert isinstance(w.check(3300), Notice)
    assert w.extend(3400) == 3600 - 3400 + 1800
    assert w.check(3600) is None
    w.heard(5000)
    # the new limit announces itself again
    assert w.check(5100) == Notice(LIMIT, 300)
    assert w.check(5400) == End(LIMIT)
