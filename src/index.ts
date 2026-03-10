/**
 * iCub Telegram Bot — Cloudflare Worker
 *
 * Thin webhook adapter: receives Telegram updates, delegates memory to
 * the Python always-on memory service, generates replies via Gemini.
 *
 * Based on GoogleCloudPlatform/generative-ai/gemini/agents/always-on-memory-agent
 */

import type { Env, TelegramUpdate, ConversationEvent } from "./types";
import { sendTelegramMessage, sendTypingAction, clampForTelegram, pickRandom, ICUB_FALLBACKS } from "./telegram";
import { ingestEvent, queryMemoryContext } from "./memory-client";
import { callGemini } from "./gemini";

const DEDUPE_TTL = 300;

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
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, greeting);
        return new Response("ok", { status: 200 });
      }

      if (text === "/reset") {
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "ok let's start fresh 👍");
        return new Response("ok", { status: 200 });
      }

      sendTypingAction(env.TELEGRAM_BOT_TOKEN, chatId);

      const userEvent = buildEvent(chatId, "user", text, msg, update.update_id);
      const ingestPromise = ingestEvent(env, userEvent).catch(() => false);
      const memoryContext = await queryMemoryContext(env, chatId);
      const rawReply = await callGemini(env, text, memoryContext);

      if (rawReply) {
        const reply = clampForTelegram(rawReply);
        const nowSec = Math.floor(Date.now() / 1000);

        ctx.waitUntil(
          (async () => {
            await ingestPromise;
            const assistantEvent = buildEvent(chatId, "assistant", rawReply, msg, update.update_id);
            assistantEvent.ts = nowSec;
            assistantEvent.user_id = String(chatId);
            await ingestEvent(env, assistantEvent).catch(() => {});
          })()
        );

        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply);
        return new Response("ok", { status: 200 });
      }

      console.log("Gemini failed for chatId:", chatId);
      ctx.waitUntil(ingestPromise);

      const fallback = pickRandom(ICUB_FALLBACKS);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, fallback);
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
