from openai import OpenAI

from bot.config import Settings


class LLMClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.client = OpenAI(
            api_key=settings.openai_api_key,
            base_url=settings.openai_base_url,
        )

    def chat(
        self,
        user_message: str,
        history: list[dict[str, str]] | None = None,
    ) -> str:
        messages: list[dict[str, str]] = [
            {"role": "system", "content": self.settings.system_prompt},
        ]
        if history:
            messages.extend(history)
        messages.append({"role": "user", "content": user_message})

        response = self.client.chat.completions.create(
            model=self.settings.openai_model,
            messages=messages,
            temperature=0.7,
        )
        content = response.choices[0].message.content
        if not content:
            raise RuntimeError("LLM returned empty response")
        return content.strip()
