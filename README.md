# iCub Telegram Bot

A Telegram chatbot deployed as a **Cloudflare Worker** that impersonates **iCub**, the small humanoid robot from IIT. Uses **Gemini** for replies and an **always-on memory service** ([Google's always-on-memory-agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)) for persistent per-user memory.

## Architecture

```
Telegram User
    │
    ▼
Cloudflare Worker (TypeScript)
    ├── verify & dedupe (KV)
    ├── ingest event ──► Memory Service (Python)
    ├── query context ◄── Memory Service
    ├── generate reply ──► Gemini API
    └── send reply ──► Telegram
                         │
Memory Service           │
    ├── IngestAgent       │  ADK + Gemini
    ├── ConsolidateAgent  │
    ├── QueryAgent        │
    ├── SQLite (per-chat) │
    └── ./inbox/<chat_id>/
```

## Stack

| Layer | Technology |
|---|---|
| Worker runtime | Cloudflare Workers (V8 isolates) |
| Worker language | TypeScript |
| Memory service | Python 3.12 + Google ADK |
| LLM | Google Gemini (sole provider) |
| Memory pattern | [always-on-memory-agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent) |
| Storage | Cloudflare KV (dedupe only) + SQLite (memories) |
| Deploy | Wrangler (Worker) + Docker (memory service) |
| Messaging | Telegram Bot API (webhook mode) |

## Memory Flow

1. User sends message → Worker receives via webhook
2. Worker sends user event to memory service (background)
3. Worker queries memory service for user context
4. Worker calls Gemini with message + memory context
5. Worker sends reply to Telegram
6. Worker sends assistant reply to memory service (background)
7. Memory service consolidates periodically (every 5 min)

## Project Structure

```
icub_chatbot/
├── src/
│   ├── index.ts           # Worker entry point (webhook adapter)
│   ├── types.ts           # Shared TypeScript types
│   ├── telegram.ts        # Telegram API helpers
│   ├── gemini.ts          # Gemini API client
│   └── memory-client.ts   # Memory service HTTP client
├── services/
│   └── always_on_memory/
│       ├── agent.py       # Memory service (ADK agents + HTTP API)
│       ├── requirements.txt
│       ├── Dockerfile
│       └── test_memory.py # Verification tests
├── docker-compose.yml     # Run memory service via Docker
├── wrangler.jsonc         # Worker deploy config
├── .env                   # All secrets + config (gitignored)
├── package.json
└── tsconfig.json
```

## Setup

### 1. Install

```bash
git clone <repo-url> && cd icub_chatbot
npm install
```

### 2. Configure

Edit `.env` with your real values:

```bash
TELEGRAM_BOT_TOKEN=...
GEMINI_API_KEY=...
GOOGLE_API_KEY=...     # same as GEMINI_API_KEY
WEBHOOK_SECRET=...
SETUP_SECRET=...
MEMORY_SERVICE_URL=http://localhost:8888
```

### 3. Start memory service

```bash
cd services/always_on_memory
pip install -r requirements.txt
export GOOGLE_API_KEY="your-key"
python agent.py
```

Or via Docker:

```bash
docker compose up -d memory
```

### 4. Set Worker secrets & deploy

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put GEMINI_API_KEY
wrangler secret put WEBHOOK_SECRET
wrangler secret put SETUP_SECRET
wrangler secret put MEMORY_SERVICE_URL
npm run deploy
```

### 5. Register webhook

```
https://tg-icub-bot.<subdomain>.workers.dev/setup?secret=<SETUP_SECRET>
```

## Environment Variables

All variables are documented in `.env`. Key ones:

| Variable | Used by | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Worker | Telegram auth |
| `GEMINI_API_KEY` | Worker | Reply generation |
| `GOOGLE_API_KEY` | Memory service | ADK agent calls |
| `WEBHOOK_SECRET` | Worker | Telegram webhook verification |
| `MEMORY_SERVICE_URL` | Worker | Memory service URL |
| `MODEL` | Memory service | Gemini model for memory ops |

## Scripts

```bash
npm run dev       # local dev
npm run deploy    # deploy Worker
npm run test      # run vitest
```

## Credits

- Memory architecture: [GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent](https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent)
- [Google ADK](https://google.github.io/adk-docs/) + [Gemini](https://ai.google.dev/)
