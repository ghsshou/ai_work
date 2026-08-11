from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    openai_api_key: str
    openai_base_url: str = "https://api.openai.com/v1"
    openai_model: str = "gpt-4o-mini"
    system_prompt: str = (
        "你是一个友好、专业的日常问答助手，回答简洁准确，必要时用中文。"
    )
    telegram_bot_token: str | None = None
    max_history_turns: int = 10


def get_settings() -> Settings:
    return Settings()
