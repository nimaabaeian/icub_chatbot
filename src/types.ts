/**
 * Shared type definitions for the iCub Telegram Bot.
 */

// ── Telegram types ──────────────────────────────────────────────

export type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
};

export type TelegramMessage = {
  message_id?: number;
  chat?: { id?: number };
  text?: string;
  date?: number;
  from?: { id?: number; first_name?: string; username?: string };
};

// ── Conversation event — written to memory service inbox ─────────

export type ConversationEvent = {
  chat_id: string;
  user_id: string;
  role: "user" | "assistant";
  telegram_update_id?: number;
  telegram_message_id?: number;
  ts: number;
  text: string;
  source: "telegram";
  user_meta?: {
    first_name?: string;
    username?: string;
  };
};

// ── Memory service responses ────────────────────────────────────

export type MemoryContextResponse = {
  chat_id: string;
  context: string;
};

export type MemoryIngestResponse = {
  status: "ingested" | "file_written";
  filepath?: string;
  response?: string;
  error?: string;
};

export type MemoryStatusResponse = {
  total_memories: number;
  unconsolidated: number;
  consolidations: number;
  chat_id?: string;
};

// ── Gemini types ────────────────────────────────────────────────

export type GeminiMessage = {
  role: "user" | "model";
  parts: Array<{ text: string }>;
};

// ── Worker operational state (KV) ───────────────────────────────
// KV is ONLY for dedupe and a small recent-exchange buffer.
// Long-term memory lives in the Python memory service.

export type RecentExchange = {
  role: "user" | "assistant";
  content: string;
  ts: number;
};

export type OperationalState = {
  recentExchanges: RecentExchange[];
  pendingUser?: { text: string; at: number };
  updatedAt: number;
};

// ── Cloudflare Worker env ───────────────────────────────────────

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
  WEBHOOK_SECRET: string;
  SETUP_SECRET: string;
  MEMORY_SERVICE_URL: string;
  CHAT_MEMORY: KVNamespace;
}
