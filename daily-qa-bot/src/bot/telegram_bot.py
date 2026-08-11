import logging

from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from bot.config import Settings
from bot.llm import LLMClient
from bot.memory import ConversationMemory

logger = logging.getLogger(__name__)


async def start_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "你好！我是日常问答助手。\n"
        "直接发消息即可提问，/clear 清空对话，/help 查看帮助。"
    )


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "命令：\n"
        "/start - 开始\n"
        "/help - 帮助\n"
        "/clear - 清空当前对话历史"
    )


async def clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    memory: ConversationMemory = context.application.bot_data["memory"]
    user_id = str(update.effective_user.id)
    memory.clear(user_id)
    await update.message.reply_text("已清空对话历史。")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not update.message or not update.message.text:
        return

    llm: LLMClient = context.application.bot_data["llm"]
    memory: ConversationMemory = context.application.bot_data["memory"]
    user_id = str(update.effective_user.id)
    user_text = update.message.text.strip()

    if not user_text:
        return

    await update.message.chat.send_action("typing")

    history = memory.get_messages(user_id)
    try:
        reply = llm.chat(user_text, history=history)
    except Exception as exc:
        logger.exception("LLM request failed")
        await update.message.reply_text(f"抱歉，处理失败：{exc}")
        return

    memory.append(user_id, "user", user_text)
    memory.append(user_id, "assistant", reply)
    await update.message.reply_text(reply)


def build_application(settings: Settings) -> Application:
    if not settings.telegram_bot_token:
        raise ValueError("TELEGRAM_BOT_TOKEN is required for telegram mode")

    llm = LLMClient(settings)
    memory = ConversationMemory(max_turns=settings.max_history_turns)

    app = Application.builder().token(settings.telegram_bot_token).build()
    app.bot_data["llm"] = llm
    app.bot_data["memory"] = memory

    app.add_handler(CommandHandler("start", start_command))
    app.add_handler(CommandHandler("help", help_command))
    app.add_handler(CommandHandler("clear", clear_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))

    return app


def run_telegram(settings: Settings) -> None:
    logging.basicConfig(
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        level=logging.INFO,
    )
    app = build_application(settings)
    print("Telegram bot 已启动，按 Ctrl+C 停止...")
    app.run_polling(allowed_updates=Update.ALL_TYPES)
