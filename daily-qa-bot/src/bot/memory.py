from collections import defaultdict, deque
from dataclasses import dataclass, field


@dataclass
class ConversationMemory:
    max_turns: int
    _store: dict[str, deque[dict[str, str]]] = field(
        default_factory=lambda: defaultdict(deque)
    )

    def get_messages(self, user_id: str) -> list[dict[str, str]]:
        return list(self._store[user_id])

    def append(self, user_id: str, role: str, content: str) -> None:
        history = self._store[user_id]
        history.append({"role": role, "content": content})
        while len(history) > self.max_turns * 2:
            history.popleft()

    def clear(self, user_id: str) -> None:
        self._store.pop(user_id, None)
