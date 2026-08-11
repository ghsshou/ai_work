import sys

from bot.config import get_settings
from bot.llm import LLMClient
from bot.memory import ConversationMemory


def run_cli() -> None:
    settings = get_settings()
    llm = LLMClient(settings)
    memory = ConversationMemory(max_turns=settings.max_history_turns)
    user_id = "cli"

    print("Daily Q&A Bot（CLI 模式）")
    print("输入问题开始对话，/clear 清空历史，/quit 退出\n")

    while True:
        try:
            user_input = input("你: ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\n再见！")
            break

        if not user_input:
            continue
        if user_input in {"/quit", "/exit", "quit", "exit"}:
            print("再见！")
            break
        if user_input == "/clear":
            memory.clear(user_id)
            print("已清空对话历史。\n")
            continue

        history = memory.get_messages(user_id)
        try:
            reply = llm.chat(user_input, history=history)
        except Exception as exc:
            print(f"错误: {exc}\n", file=sys.stderr)
            continue

        memory.append(user_id, "user", user_input)
        memory.append(user_id, "assistant", reply)
        print(f"\nBot: {reply}\n")
