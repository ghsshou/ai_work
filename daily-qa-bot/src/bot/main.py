import argparse
import sys
from pathlib import Path

# 允许 `python -m bot.main` 从 src 目录运行
SRC_DIR = Path(__file__).resolve().parents[1]
if str(SRC_DIR) not in sys.path:
    sys.path.insert(0, str(SRC_DIR))

from bot.cli import run_cli
from bot.config import get_settings
from bot.telegram_bot import run_telegram


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily Q&A Bot")
    parser.add_argument(
        "mode",
        choices=["cli", "telegram"],
        nargs="?",
        default="cli",
        help="运行模式：cli（终端）或 telegram",
    )
    args = parser.parse_args()
    settings = get_settings()

    if args.mode == "cli":
        run_cli()
    else:
        run_telegram(settings)


if __name__ == "__main__":
    main()
