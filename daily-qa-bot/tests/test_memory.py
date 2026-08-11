from bot.memory import ConversationMemory


def test_memory_keeps_recent_turns() -> None:
    memory = ConversationMemory(max_turns=2)
    user_id = "u1"

    memory.append(user_id, "user", "q1")
    memory.append(user_id, "assistant", "a1")
    memory.append(user_id, "user", "q2")
    memory.append(user_id, "assistant", "a2")
    memory.append(user_id, "user", "q3")
    memory.append(user_id, "assistant", "a3")

    messages = memory.get_messages(user_id)
    assert len(messages) == 4
    assert messages[0]["content"] == "q2"


def test_clear_memory() -> None:
    memory = ConversationMemory(max_turns=5)
    user_id = "u1"
    memory.append(user_id, "user", "hello")
    memory.clear(user_id)
    assert memory.get_messages(user_id) == []
