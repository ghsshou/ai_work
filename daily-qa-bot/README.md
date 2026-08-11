# daily-qa-bot

基于大模型的**日常问答 Bot**，支持终端（CLI）与 Telegram 两种使用方式，对接任意 **OpenAI 兼容 API**（OpenAI、DeepSeek、本地 vLLM 等）。

## 功能

- 多轮对话，自动保留最近 N 轮上下文
- CLI 模式：本地终端快速问答
- Telegram 模式：手机随时提问
- 可自定义系统提示词与模型

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/ghsshou/daily-qa-bot.git
cd daily-qa-bot
```

### 2. 安装依赖

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY 等配置
```

| 变量 | 说明 | 必填 |
|------|------|------|
| `OPENAI_API_KEY` | API 密钥 | 是 |
| `OPENAI_BASE_URL` | API 地址，默认 `https://api.openai.com/v1` | 否 |
| `OPENAI_MODEL` | 模型名，默认 `gpt-4o-mini` | 否 |
| `SYSTEM_PROMPT` | 系统提示词 | 否 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token（仅 telegram 模式） | 否 |
| `MAX_HISTORY_TURNS` | 保留对话轮数，默认 10 | 否 |

### 4. 运行

**CLI 模式（终端问答）：**

```bash
cd src
python -m bot.main cli
```

**Telegram 模式：**

1. 在 [@BotFather](https://t.me/BotFather) 创建 Bot，获取 Token
2. 将 Token 写入 `.env` 的 `TELEGRAM_BOT_TOKEN`
3. 启动：

```bash
cd src
python -m bot.main telegram
```

## 使用 DeepSeek / 其他兼容 API

在 `.env` 中修改：

```env
OPENAI_API_KEY=your-deepseek-key
OPENAI_BASE_URL=https://api.deepseek.com/v1
OPENAI_MODEL=deepseek-chat
```

## 命令（Telegram）

| 命令 | 说明 |
|------|------|
| `/start` | 开始对话 |
| `/help` | 查看帮助 |
| `/clear` | 清空当前用户的对话历史 |

CLI 模式：`/clear` 清空历史，`/quit` 退出。

## 项目结构

```
daily-qa-bot/
├── src/bot/
│   ├── main.py          # 入口
│   ├── config.py        # 配置
│   ├── llm.py           # LLM 客户端
│   ├── memory.py        # 对话记忆
│   ├── cli.py           # CLI 模式
│   └── telegram_bot.py  # Telegram 模式
├── tests/
├── .env.example
├── requirements.txt
└── README.md
```

## 开发

```bash
pip install -e .
pytest
```

## License

MIT
