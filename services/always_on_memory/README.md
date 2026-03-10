# Always-On Memory Service

> Adapted from [GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)

Persistent per-user memory for the iCub Telegram Bot. Uses Google ADK + Gemini to ingest, consolidate, and query structured memories scoped per Telegram chat.

## How It Works

**Ingest** — Worker sends conversation events → memory service writes JSON to `./inbox/<chat_id>/` and extracts structured memories (summary, entities, topics, importance) into SQLite.

**Consolidate** — Every 5 minutes, reviews unconsolidated memories per chat, finds patterns and connections, generates insights.

**Query** — Worker asks for user context before each reply → memory service synthesizes a brief summary from all stored memories and consolidation insights.

## API

| Method | Endpoint | Description |
|---|---|---|
| POST | `/ingest-event` | Write & ingest a conversation event |
| POST | `/context` | Get user context for prompt injection |
| POST | `/query` | Query memories with a question |
| POST | `/consolidate` | Trigger consolidation |
| GET | `/status` | Memory stats (optional `?chat_id=`) |
| GET | `/memories?chat_id=` | List memories for a chat |
| GET | `/` | Health check |

## Setup

```bash
pip install -r requirements.txt
export GOOGLE_API_KEY="your-key"
python agent.py
# → http://localhost:8888
```

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `GOOGLE_API_KEY` | (required) | Gemini API key |
| `MODEL` | `gemini-2.0-flash-lite` | Model for memory ops |
| `MEMORY_DB` | `./memory.db` | SQLite path |
| `INBOX_PATH` | `./inbox` | Inbox folder |
| `PORT` | `8888` | HTTP port |
| `CONSOLIDATE_EVERY_MINUTES` | `5` | Consolidation interval |
| `CONSOLIDATE_MIN_EVENTS` | `4` | Min events per chat |

## Tests

```bash
python test_memory.py --offline   # DB-only tests (no Gemini needed)
python test_memory.py             # full integration (requires running service)
```
