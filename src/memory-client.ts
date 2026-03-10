/**
 * Memory Service Client
 *
 * HTTP client for the Python always-on memory service.
 * All calls are time-bounded and fail gracefully — if the memory
 * service is unavailable, the bot still replies without memory context.
 *
 * Based on Google's always-on-memory-agent:
 * https://github.com/GoogleCloudPlatform/generative-ai/tree/main/gemini/agents/always-on-memory-agent
 */

import type { Env, ConversationEvent, MemoryContextResponse, MemoryIngestResponse } from "./types";

const MEMORY_TIMEOUT_MS = 8_000;

export async function ingestEvent(env: Env, event: ConversationEvent): Promise<boolean> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), MEMORY_TIMEOUT_MS);
    try {
      const resp = await fetch(`${env.MEMORY_SERVICE_URL}/ingest-event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
        signal: controller.signal,
      });
      const data = await resp.json().catch(() => ({})) as MemoryIngestResponse;
      if (!resp.ok) {
        console.log("Memory ingest returned error:", resp.status, data);
        return false;
      }
      return true;
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    console.log("Memory ingest failed (non-fatal):", String(err));
    return false;
  }
}

export async function queryMemoryContext(env: Env, chatId: number): Promise<string> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), MEMORY_TIMEOUT_MS);
    try {
      const resp = await fetch(`${env.MEMORY_SERVICE_URL}/context`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: String(chatId) }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        console.log("Memory context query returned error:", resp.status);
        return "";
      }

      const data = await resp.json().catch(() => ({})) as MemoryContextResponse;
      const ctx = data.context || "";

      if (ctx.toLowerCase().includes("no prior context") || ctx.toLowerCase().includes("no memories")) {
        return "";
      }
      return ctx;
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    console.log("Memory context query failed (non-fatal):", String(err));
    return "";
  }
}

export async function isMemoryServiceHealthy(env: Env): Promise<boolean> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 3_000);
    try {
      const resp = await fetch(`${env.MEMORY_SERVICE_URL}/status`, { signal: controller.signal });
      return resp.ok;
    } finally {
      clearTimeout(tid);
    }
  } catch {
    return false;
  }
}
