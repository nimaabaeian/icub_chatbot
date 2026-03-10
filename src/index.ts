/**
 * iCub Telegram Bot — Cloudflare Worker
 *
 * Thin webhook adapter: receives Telegram updates, delegates memory to
 * the Python always-on memory service, generates replies via Gemini.
 *
 * Based on GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent
 */

import type { Env, TelegramUpdate, ConversationEvent, RecentExchange, OperationalState } from "./types";
import { sendTelegramMessage, sendTypingAction, clampForTelegram, pickRandom, ICUB_FALLBACKS } from "./telegram";
import { ingestEvent, queryMemoryContext } from "./memory-client";
import { callGemini } from "./gemini";

const DEDUPE_TTL = 300;
const RECENT_EXCHANGE_WINDOW = 6;
const KV_STATE_TTL = 86400;
const PENDING_TTL_MS = 10 * 60 * 1000;

async function loadOperationalState(env: Env, chatId: number): Promise<OperationalState> {
  const base: OperationalState = { recentExchanges: [], updatedAt: Date.now() };
  try {
    const raw = await env.CHAT_MEMORY.get(`state:${chatId}`);
    if (raw) Object.assign(base, JSON.parse(raw));
  } catch { /* start fresh */ }
  return base;
}

async function saveOperationalState(env: Env, chatId: number, state: OperationalState): Promise<void> {
  await env.CHAT_MEMORY.put(`state:${chatId}`, JSON.stringify(state), { expirationTtl: KV_STATE_TTL });
}

function buildEvent(
  chatId: number,
  role: "user" | "assistant",
  text: string,
  msg?: TelegramUpdate["message"],
  updateId?: number
): ConversationEvent {
  return {
    chat_id: String(chatId),
    user_id: String(msg?.from?.id ?? chatId),
    role,
    telegram_update_id: updateId,
    telegram_message_id: msg?.message_id,
    ts: msg?.date ?? Math.floor(Date.now() / 1000),
    text,
    source: "telegram",
    user_meta: msg?.from ? { first_name: msg.from.first_name, username: msg.from.username } : undefined,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok");
    }

    if (request.method === "GET" && url.pathname === "/setup") {
      if (url.searchParams.get("secret") !== env.SETUP_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const hookUrl = `${url.origin}/webhook`;
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: hookUrl, secret_token: env.WEBHOOK_SECRET, drop_pending_updates: true }),
      });
      return Response.json({ hookUrl, telegram: await r.json().catch(() => ({})) });
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!incoming || incoming !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = (await request.json().catch(() => ({}))) as TelegramUpdate;

      if (update.update_id != null) {
        const dedupeKey = `dedupe:${update.update_id}`;
        if (await env.CHAT_MEMORY.get(dedupeKey)) return new Response("ok", { status: 200 });
        await env.CHAT_MEMORY.put(dedupeKey, "1", { expirationTtl: DEDUPE_TTL }).catch(() => {});
      }

      const msg = update.message ?? update.edited_message;
      const chatId = msg?.chat?.id;
      const text = msg?.text?.trim();
      if (!chatId || !text) return new Response("ignored", { status: 200 });

      if (text === "/start") {
        const fromName = msg.from?.first_name || msg.from?.username;
        const greeting = fromName ? `hey ${fromName}! i'm iCub 🤖 what's up?` : "hey! i'm iCub 🤖 what's on your mind?";
        await saveOperationalState(env, chatId, { recentExchanges: [], updatedAt: Date.now() }).catch(() => {});
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, greeting);
        return new Response("ok", { status: 200 });
      }

      if (text === "/reset") {
        await saveOperationalState(env, chatId, { recentExchanges: [], updatedAt: Date.now() }).catch(() => {});
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "ok let's start fresh 👍");
        return new Response("ok", { status: 200 });
      }

      const state = await loadOperationalState(env, chatId);
      sendTypingAction(env.TELEGRAM_BOT_TOKEN, chatId);

      let pendingNotice: string | null = null;
      if (state.pendingUser) {
        if (Date.now() - state.pendingUser.at < PENDING_TTL_MS) {
          const snippet = state.pendingUser.text.length > 60
            ? state.pendingUser.text.slice(0, 60) + "…"
            : state.pendingUser.text;
          pendingNotice = `Oops, I might have missed your last message: "${snippet}". Do you still want help with that?`;
        }
        state.pendingUser = undefined;
      }

      const userEvent = buildEvent(chatId, "user", text, msg, update.update_id);
      const ingestPromise = ingestEvent(env, userEvent).catch(() => false);
      const memoryContext = await queryMemoryContext(env, chatId);
      const rawReply = await callGemini(env, text, memoryContext, state.recentExchanges);

      if (rawReply) {
        const reply = clampForTelegram(rawReply);
        const nowSec = Math.floor(Date.now() / 1000);
        const updatedExchanges: RecentExchange[] = [
          ...state.recentExchanges,
          { role: "user" as const, content: text, ts: msg.date ?? nowSec },
          { role: "assistant" as const, content: rawReply, ts: nowSec },
        ].slice(-RECENT_EXCHANGE_WINDOW);

        ctx.waitUntil(
          (async () => {
            await ingestPromise;
            const assistantEvent = buildEvent(chatId, "assistant", rawReply, msg, update.update_id);
            assistantEvent.ts = nowSec;
            assistantEvent.user_id = String(chatId);
            await ingestEvent(env, assistantEvent).catch(() => {});
            await saveOperationalState(env, chatId, {
              recentExchanges: updatedExchanges,
              pendingUser: undefined,
              updatedAt: Date.now(),
            }).catch(() => {});
          })()
        );

        const finalReply = pendingNotice ? clampForTelegram(`${pendingNotice}\n\n${reply}`) : reply;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, finalReply);
        return new Response("ok", { status: 200 });
      }

      console.log("Gemini failed for chatId:", chatId);
      state.pendingUser = { text, at: Date.now() };
      ctx.waitUntil(saveOperationalState(env, chatId, state).catch(() => {}));
      ctx.waitUntil(ingestPromise);

      const fallback = pickRandom(ICUB_FALLBACKS);
      const finalReply = pendingNotice ? clampForTelegram(`${pendingNotice}\n\n${fallback}`) : fallback;
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, finalReply);
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
