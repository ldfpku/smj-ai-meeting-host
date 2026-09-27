from model_caps import DEFAULT_LIVE_MODEL, SUPPORTED_LIVE_MODELS, resolve_model


def test_supported_models_resolve_to_themselves():
    for model_id in SUPPORTED_LIVE_MODELS:
        resolved, _, replaced = resolve_model(model_id)
        assert resolved == model_id
        assert replaced is False


def test_38_models_never_take_the_proactivity_flag():
    for model_id in ("gemini-3.8-live", "gemini-3.8-live-extended-thinking"):
        _, caps, _ = resolve_model(model_id)
        assert caps.supports_proactivity_flag is False
        assert caps.audio_only is True
        assert caps.tool_behavior == "BLOCKING"
        assert caps.send_temperature is False


def test_31_keeps_plugin_defaults():
    _, caps, _ = resolve_model("gemini-3.1-flash-live-preview")
    assert caps.tool_behavior is None
    assert caps.audio_only is False
    assert caps.send_temperature is True


def test_removed_and_unknown_models_fall_back_to_default():
    for model_id in (
        "gemini-2.5-flash-native-audio-preview-12-2025",
        "gemini-9.9-imaginary",
        "",
        None,
    ):
        resolved, caps, replaced = resolve_model(model_id)
        assert resolved == DEFAULT_LIVE_MODEL
        assert replaced is True
        assert caps.audio_only is True
