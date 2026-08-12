import pytest
from pydantic import ValidationError

from bot.config import Settings


@pytest.mark.parametrize("max_history_turns", [0, -1])
def test_settings_reject_non_positive_history_turns(max_history_turns: int) -> None:
    with pytest.raises(ValidationError):
        Settings(
            openai_api_key="test-key",
            max_history_turns=max_history_turns,
            _env_file=None,
        )


def test_settings_accept_positive_history_turns() -> None:
    settings = Settings(
        openai_api_key="test-key",
        max_history_turns=1,
        _env_file=None,
    )

    assert settings.max_history_turns == 1
