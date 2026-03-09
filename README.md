# iCub chat bot

A Telegram chatbot deployed as a **Cloudflare Worker** that impersonates **iCub**, the small humanoid research robot from the Italian Institute of Technology (IIT). The bot has no fixed LLM backend — it tries a prioritised list of free OpenRouter models in order and falls back gracefully when any of them fail.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers (V8 isolates) |
| Language | TypeScript 5.x |
| Deploy | Wrangler 4.x |
| Storage | Cloudflare KV (`CHAT_MEMORY`) |
| LLM | OpenRouter — free-tier model cascade |
| Messaging | Telegram Bot API — webhook mode |

## Models

Current fallback order (`MODELS_TO_TRY` in `src/index.ts`):

1. `stepfun/step-3.5-flash:free`
2. `mistralai/mistral-small-3.1-24b-instruct:free`
3. `meta-llama/llama-3.3-70b-instruct:free`
4. `z-ai/glm-4.5-air:free`
5. `nousresearch/hermes-3-llama-3.1-405b:free`
6. `google/gemma-3-27b-it:free` (systemless handling)
7. `openrouter/free`

Notes:
- The bot tries `lastGoodModel` first when available, then follows the order above.
- Summarization uses the first non-Gemma model from this list.

## Major Features

- Per-chat persistent memory in KV: rolling transcript, rolling summary, and a rich user profile.
- Sticky successful model selection via `lastGoodModel` to improve response reliability/latency.
- Pending-message recovery: if all models fail, the last user message is saved and surfaced on the next turn.
- Telegram reliability guards: webhook secret verification + `update_id` deduplication.
- `/start` clears conversation history but preserves the full user profile.
- `/reset` does the same as `/start` without a greeting — useful mid-conversation.
- In-character fallback replies when all models fail — iCub never exposes backend errors to the user.
- **Timezone awareness**: the user's UTC offset is inferred from explicit expressions ("UTC+2"), local-time hints ("it's 3 pm here"), or city/country name matching against a DST-aware lookup table covering Europe, US, Asia, Africa, and Oceania.
- **Message timestamps**: every stored message carries a Unix-seconds `ts` from Telegram's `date` field; the model context includes the exact local date/time and relative age of each history turn, plus a note on how long it has been since the user's last session.

## Memory

State is stored per-chat in the `CHAT_MEMORY` KV namespace under **two separate keys**:

| Key | TTL | Contents |
|---|---|---|
| `chat:<id>` | 24 h | Conversation history, summary, turn counters, sticky model |
| `profile:<id>` | **none** (kept forever) | Full user profile — survives `/start` and `/reset` |
| `dedupe:<update_id>` | 5 min | Deduplication sentinel |

Memory is loaded at the start of each request and written back asynchronously via `ctx.waitUntil()`.

### Chat state

| Field | Purpose |
|---|---|
| `messages` | Rolling window of the last 20 turns; each entry carries an optional `ts` (Unix seconds from Telegram `date`) |
| `summary` | LLM-generated rolling summary, regenerated every 8 new turns |
| `turnCount` | Total successful turns stored so far |
| `lastSummarizedAt` | `turnCount` value at the last summary update |
| `lastGoodModel` | Sticky model choice tried first on the next request |
| `pendingUser` | Last user message saved when all models fail; recovered within 10 min |
| `updatedAt` | Timestamp (ms epoch) of the last KV write |

Only the most recent 6 messages (`CONTEXT_WINDOW`) are forwarded to the model; older context is covered by the rolling summary. Summarisation is **incremental** — only the turns added since the last summary are sent to the summariser, preventing drift over long conversations.

Before being sent to a model, each context-window message is annotated with its exact local date/time and relative age (e.g. `[Mon 06 Mar 2026, 11:42 PM — 3 days ago]`). The current request additionally injects:

- **`timeNote`** — the local day/time the message was sent, e.g. "The user sent this message on a Tuesday night (11:42 PM UTC+01:00)".
- **`gapNote`** — if ≥ 30 min have elapsed since the user's last message, e.g. "It has been 2 days ago since the user last sent a message".

### User profile

Extracted automatically from every message via regex patterns and Telegram metadata. Profiles survive `/start` resets.

| Field | Purpose |
|---|---|
| `userName` | Display name from Telegram or patterns like "call me X", "my name is X" |
| `userNickname` | Preferred nickname — "just call me X", "my friends call me X", etc. |
| `userAge` | Age captured from a wide range of expressions: "I'm 23", "just turned 18", "turning 25 soon", etc. (valid range: 5–120) |
| `userLikes` | Up to 5 things the user mentioned liking / loving / enjoying |
| `userDislikes` | Up to 5 things the user mentioned hating / disliking / can't stand |
| `userFavoriteTopics` | Up to 5 topics the user is into ("I'm really into X", "I nerd out about X", etc.) |
| `userRelationshipStyle` | Detected interaction style, e.g. `"protective"` |
| `userInsideJokes` | Up to 5 confirmed inside jokes — a phrase is promoted here only after being referenced 2+ times |
| `userJokeCandidates` | Staging area for potential inside jokes: `Record<phrase, [count, first_seen_ms]>`; expires after 30 days, capped at 20 entries |
| `userTrustLevel` | `"friend"` (default) or `"close_friend"` — escalates on explicit trust signals |
| `userLastPersonalUpdate` | Most recent life/status snippet — covers health, mood, location, school/work, travel, and life events ("I've got an exam", "i'm drunk", "just got promoted", "i'm pregnant", etc.) |
| `userConversationStyle` | `{ usesEmojis, messageLength, tone }` — inferred from message content |
| `userFirstTalked` | Timestamp (ms epoch) of the user's first message |
| `userLastTalked` | Timestamp (ms epoch) of the user's most recent message |
| `userUtcOffset` | UTC offset in hours (e.g. `1` for CET, `-5` for EST) — inferred from explicit offset strings, local-time hints ("it's 3 pm here"), or city/country name; defaults to Italy CET/CEST when unknown |

Profile facts are serialised into a compact `Key: value` string and wrapped in an explicit instruction block before being injected into the model context. The wrapper instructs the model to treat the data as **silent background context only** — it must never proactively reference, mention, or allude to any profile fact unless the user's current message directly touches on that topic first. The combined string is capped at 600 characters.

---

## Directory Structure

```
tg-icub-bot/
├── src/
│   └── index.ts                  ← entire worker logic
├── wrangler.jsonc                 ← deploy config (KV binding, compat flags)
├── tsconfig.json
├── package.json
└── worker-configuration.d.ts     ← generated by `wrangler types`
```

## Setup

### 1. Prerequisites
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [OpenRouter account](https://openrouter.ai) — free tier is enough
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

### 2. Clone & install

```bash
git clone <your-repo-url>
cd tg-icub-bot
npm install
```

### 3. Create the KV namespace

```bash
npx wrangler kv namespace create CHAT_MEMORY
```

Paste the printed `id` into `wrangler.jsonc` under `kv_namespaces`.

### 4. Set secrets

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler secret put WEBHOOK_SECRET      # any random string
npx wrangler secret put SETUP_SECRET        # any random string
```

### 5. Deploy

```bash
npm run deploy
```

### 6. Register the webhook

Hit this URL once in your browser (replace values):

```
https://tg-icub-bot.<your-subdomain>.workers.dev/setup?secret=<SETUP_SECRET>
```

The worker calls Telegram's `setWebhook` and returns the result as JSON.

---

## Architecture

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/` | Health check — returns `ok` |
| `GET` | `/setup?secret=<SETUP_SECRET>` | Registers the Telegram webhook |
| `POST` | `/webhook` | Receives Telegram updates (the hot path) |

### Webhook flow

`POST /webhook` hot path:

1. **Verify** — checks `X-Telegram-Bot-Api-Secret-Token`
2. **Deduplicate** — `update_id` cached in KV for 5 min prevents double-processing
3. **Load memory** — reads `ChatMemory` from KV for the chat
4. **Extract user profile** — name, nickname, age, likes, dislikes, favourite topics, relationship style, inside jokes, trust level, life/status updates, conversation style (emoji usage, message length, tone), interaction timestamps, and **UTC offset** parsed from message text and Telegram metadata; persisted across sessions
5. **Timezone & timestamp context** — derives the effective UTC offset (defaulting to Italy CET/CEST if unknown), annotates each history message with exact local date/time + relative age, and injects a `timeNote` / `gapNote` into the user context
6. **Ambiguity rewrite** — short affirmatives ("yep", "sure") are expanded before sending to the model
7. **Model cascade** — tries `MODELS_TO_TRY` in order, sticky on `lastGoodModel`
8. **Reply** — clamps to 450 chars, sends via Telegram `sendMessage`
9. **Background write** — `ctx.waitUntil()` runs summarisation + KV save without blocking the response

### Model fallback

- `TOTAL_BUDGET_MS` = 30 s global deadline
- `MODEL_TIMEOUT_MS` = 20 s per model
- `MAX_RETRIES_PER_MODEL` = 2, with 200–600 ms jitter
- Transient codes (429, 5xx): retry → next model
- 404: skip model immediately
- 401/402/403: abort entire loop, send friendly in-character fallback

### Systemless model handling (Gemma)

Models with the `google/gemma-` prefix reject system-role messages. For these, the system prompt, summary, and transcript are folded into a single `user` message.

### Secrets

| Secret | Purpose |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Telegram Bot API auth |
| `OPENROUTER_API_KEY` | OpenRouter API auth |
| `WEBHOOK_SECRET` | Header token Telegram sends with every update |
| `SETUP_SECRET` | Guards the `/setup` endpoint |

Optional plain env vars (set in `wrangler.jsonc` under `vars` or via `wrangler secret put`):

| Variable | Default | Purpose |
|---|---|---|
| `APP_NAME` | `"iCub Telegram Bot"` | Sent as `X-OpenRouter-Title` header |
| `APP_URL` | `"https://example.com"` | Sent as `HTTP-Referer` header |

> Secrets are set via `wrangler secret put` and never committed to git.

## Scripts

```bash
npm run dev         # local dev with wrangler
npm run deploy      # deploy to Cloudflare Workers
npm run cf-typegen  # regenerate worker-configuration.d.ts
```
