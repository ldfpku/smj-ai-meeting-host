from intervention import (
    AGENDA_GRACE_SECONDS,
    UNDO_COOLDOWN_FACTOR,
    InterventionGate,
    InterventionSettings,
)


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def make_gate(**settings) -> tuple[InterventionGate, FakeClock]:
    clock = FakeClock()
    gate = InterventionGate(settings=InterventionSettings(**settings), clock=clock)
    return gate, clock


def test_detectors_share_one_cooldown():
    gate, clock = make_gate(cooldown_seconds=45)

    assert gate.try_acquire("jev") is not None
    # the Live model notices the same digression a moment later
    clock.advance(3)
    assert gate.try_acquire("model") is None

    clock.advance(45)
    assert gate.try_acquire("model") is not None


def test_manual_request_bypasses_cooldown_but_restarts_it():
    gate, clock = make_gate(cooldown_seconds=45)

    assert gate.try_acquire("jev") is not None
    clock.advance(1)
    assert gate.try_acquire("manual") is not None

    clock.advance(44)
    assert gate.try_acquire("jev") is None
    clock.advance(2)
    assert gate.try_acquire("jev") is not None


def test_no_automatic_interruption_while_the_moderator_speaks():
    gate, _ = make_gate()

    assert gate.try_acquire("jev", agent_speaking=True) is None
    assert gate.try_acquire("manual", agent_speaking=True) is not None


def test_hold_after_agenda_advance():
    gate, clock = make_gate()

    gate.hold()
    assert gate.try_acquire("jev") is None
    clock.advance(AGENDA_GRACE_SECONDS + 0.1)
    assert gate.try_acquire("jev") is not None


def test_undo_extends_cooldown_and_records_false_positive():
    gate, clock = make_gate(cooldown_seconds=40, threshold=0.85)

    intervention = gate.try_acquire("jev")
    assert intervention is not None
    intervention.confidence = 0.91
    intervention.reason_code = "side_issue"

    undone = gate.undo(intervention.id)
    assert undone is intervention
    assert undone.undone is True
    assert gate.false_positives[0]["confidence"] == 0.91
    assert gate.false_positives[0]["threshold"] == 0.85

    clock.advance(40 + 1)
    assert gate.try_acquire("jev") is None
    clock.advance(40 * (UNDO_COOLDOWN_FACTOR - 1))
    assert gate.try_acquire("jev") is not None


def test_undo_is_idempotent_and_checks_the_id():
    gate, _ = make_gate()

    assert gate.undo() is None

    intervention = gate.try_acquire("jev")
    assert gate.undo("int-someone-else") is None
    assert gate.undo(intervention.id) is intervention
    assert gate.undo(intervention.id) is None
    assert len(gate.false_positives) == 1


def test_settings_tolerate_bad_input():
    settings = InterventionSettings.from_dict(
        {
            "mode": "whatever",
            "threshold": "2",
            "cooldownSeconds": -5,
            "consecutiveHits": "abc",
        }
    )
    assert settings.mode == "semi_auto"
    assert settings.threshold == 0.99
    assert settings.cooldown_seconds == 5.0
    assert settings.consecutive_hits == 1

    assert InterventionSettings.from_dict(None) == InterventionSettings()

    settings = InterventionSettings.from_dict(
        {"mode": "semi_auto", "threshold": 0.7, "cooldownSeconds": 60, "consecutiveHits": 2}
    )
    assert settings.to_dict() == {
        "mode": "semi_auto",
        "threshold": 0.7,
        "cooldownSeconds": 60.0,
        "consecutiveHits": 2,
    }
