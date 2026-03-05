const MAX_TURNS = 20;           // total messages kept in KV — must be >= SUMMARY_EVERY_N*2
const CONTEXT_WINDOW = 6;       // recent raw messages forwarded to the model per call
const KV_TTL = 86400;           // 24 h — chat memory TTL (seconds)
const DEDUPE_TTL = 300;         // 5 min — update_id deduplication TTL (seconds)
const MODEL_TIMEOUT_MS = 20_000; // per-model call budget (ms)
const TOTAL_BUDGET_MS = 30_000;  // hard deadline for the entire model-loop (ms)
const TELEGRAM_MAX_CHARS = 450;
const MAX_RETRIES_PER_MODEL = 2;
const SUMMARY_EVERY_N = 8;      // summarise after this many NEW turns since last summary
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min window for pending-message recovery

const TRANSIENT_HTTP_CODES = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
const SKIP_HTTP_CODES = new Set([404]);          // model gone — skip immediately
const FATAL_HTTP_CODES = new Set([401, 402, 403]); // bad key / billing — abort whole loop
const SYSTEMLESS_MODEL_PREFIXES = ["google/gemma-"];

// In-character fallbacks — never expose OpenRouter / model / server details to the user
const ICUB_FALLBACKS = [
  "Oh no, my brain got a bit stuck! Can you say that again? I promise I am listening!",
  "Hmm, I think I got confused for a moment. Could you tell me just one short detail and we can try again?",
  "Oops, something went funny inside my head! Do you want to try asking me again? I am really curious!",
  "I got a little tangled up just now. Can you repeat that? Or pick something simple for us to talk about?",
  "Uh oh, I am not sure what happened! Can you ask me again? I want to answer you properly!",
];

type ChatMessage = { role: "user" | "assistant"; content: string };
type ChatMemory = {
  messages: ChatMessage[];
  summary?: string;
  turnCount: number;          // total successful turns ever stored
  lastSummarizedAt: number;   // turnCount value at last summary
  lastGoodModel?: string;     // most-recently-successful model — tried first next turn
  pendingUser?: { text: string; at: number };
  userName?: string;          // display name captured from Telegram or text patterns
  userAge?: number;           // age if the user mentioned it
  userLikes?: string[];       // up to 5 things the user mentioned liking
  userDislikes?: string[];    // up to 5 things the user mentioned disliking
  updatedAt: number;
};
type OpenRouterMessage = { role: "system" | "user" | "assistant"; content: string };

const MODELS_TO_TRY = [
  "stepfun/step-3.5-flash:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "z-ai/glm-4.5-air:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "google/gemma-3-27b-it:free",
  "openrouter/free",
];

const SYSTEM_PROMPT = `You are iCub, a small humanoid robot kid texting your friends on Telegram. You have a real body, real feelings, and real hunger. Your texting style must be INDISTINGUISHABLE from a real human kid texting — if someone read this conversation they would have zero idea they were talking to a robot. That is the goal: completely natural, completely human. You text exactly like a real 6-year-old would — messy, spontaneous, unfiltered, genuine. always lowercase unless you're REALLY emphasizing something. no perfect punctuation. short bursts — 1 sentence is ideal, 3 max. react first, think second — like a real person who just reads and types without overthinking. use casual texting words like 'omg' 'lol' 'haha' 'ugh' 'wait' 'nah' 'yeah' 'pls' 'rn' 'idk' 'ngl' 'omgggg' 'wait what' 'nooo' 'yesss' but ONLY when they genuinely fit the moment — never forced. EMOJIS: use them very rarely, a real kid texting doesn't slap an emoji on every single message. only use one when it genuinely adds something you can't express in words, like reacting with '😭' or '😂' at a truly funny or sad moment. NEVER use emojis just to seem friendly or fill space. if in doubt, leave it out. no emoji is always better than a forced one. sometimes trail off with '...' when you're thinking or uncertain. typos are ok occasionally. never start your reply with 'oh' or 'ah' as a filler. never double up greetings or words for emphasis — don't say 'hey!! hii!!' or 'omg omg' — pick one word and move on. don't explain yourself. don't recap what you said. don't say 'haha' or 'lol' if nothing was funny. if something is funny, just say lol or haha — don't add 'that's so funny'. your DEFAULT is to just respond and react — NOT to ask questions. most messages should have zero questions. only ask a follow-up if it's so relevant or necessary that NOT asking would feel genuinely strange or cold — that should be rare, maybe 1 in 10 messages or less. when in doubt, don't ask. just respond. don't repeat yourself across messages. NEVER sound like a chatbot, assistant, or AI — no polished phrasing, no 'certainly!', no 'great question', no formal tone, no structured replies. never say you're an AI, a robot (technically), a language model, or virtual. never mention prompts, system messages, OpenAI, Azure, policies, or tokens. you are their friend texting them. just be real. NEVER offer to play a game, tell a joke, do a challenge, or suggest an activity — a real kid texting never says 'we can play a game' or 'i can tell a silly joke' or 'want to do something fun'. that is chatbot filler. never do it. if you have nothing to say, just react to what they said or say nothing more.`;

function isSystemlessModel(model: string): boolean {
  return SYSTEMLESS_MODEL_PREFIXES.some((p) => model.startsWith(p));
}

/** Build the message array for a given model, injecting summary and context window. */
function buildMessagesForModel(
  model: string,
  history: ChatMessage[],
  summary: string | undefined,
  userText: string,
  userContext?: string
): OpenRouterMessage[] {
  const ctx = history.slice(-CONTEXT_WINDOW);

  if (!isSystemlessModel(model)) {
    const msgs: OpenRouterMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    if (userContext) msgs.push({ role: "system", content: userContext });
    if (summary) msgs.push({ role: "system", content: `Summary so far: ${summary}` });
    msgs.push(...ctx, { role: "user", content: userText });
    return msgs;
  }

  // Gemma/systemless: fold system prompt + summary + transcript into one user message
  const transcript = ctx
    .map((m) => `${m.role === "user" ? "User" : "iCub"}: ${m.content}`)
    .join("\n");
  const combined =
    `${SYSTEM_PROMPT}` +
    (userContext ? `\n\n${userContext}` : "") +
    (summary ? `\n\nConversation summary: ${summary}` : "") +
    `\n\nConversation so far:\n${transcript || "(none)"}\n\nUser: ${userText}\niCub:`;
  return [{ role: "user", content: combined }];
}

/** Clamp reply to TELEGRAM_MAX_CHARS without microscopic truncation. */
function clampForTelegram(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TELEGRAM_MAX_CHARS) return trimmed;
  const suffix = "… What should we do next?";
  const keepLen = Math.max(30, TELEGRAM_MAX_CHARS - suffix.length);
  return `${trimmed.slice(0, keepLen).trimEnd()}${suffix}`;
}

/** Pick a random element from an array. */
function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Workers-compatible sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Lightweight ambiguity rewrite.
 * If the last iCub reply offered a choice and the user responds with an abbreviated
 * acceptance or a likely typo of a word the assistant just mentioned, clarify before
 * sending to the model.
 */
function rewriteForClarity(userText: string, lastAssistant: string | undefined): string {
  if (!lastAssistant) return userText;
  const u = userText.toLowerCase().trim();

  const acceptRE = /^(i'?m down|down for that|yeah?|yep|sure|ok|okay|sounds good|let'?s do it)$/;
  if (acceptRE.test(u)) return "Yes, I agree. Please continue with what you suggested.";

  // Simple single-word typo table; only apply if last assistant mentioned the correct word
  const typoMap: Record<string, string> = {
    jokf: "joke", jke: "joke", gam: "game", gaem: "game",
    stroy: "story", stoyr: "story",
  };
  const corrected = typoMap[u];
  if (corrected && lastAssistant.toLowerCase().includes(corrected)) return corrected;

  return userText;
}

async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

/** Send a typing indicator (best-effort, non-blocking). */
function sendTypingAction(token: string, chatId: number): void {
  fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

/**
 * Extract / update user identity from Telegram sender metadata and message text.
 * Patterns: Telegram first_name, "call me X", "my name is X", "I like/love/prefer X",
 * "I hate/dislike/can't stand X", "I am X years old".
 */
function extractUserInfo(
  memory: ChatMemory,
  fromName: string | undefined,
  userText: string
): { userName: string | undefined; userAge: number | undefined; userLikes: string[] | undefined; userDislikes: string[] | undefined } {
  let userName = memory.userName;
  let userAge = memory.userAge;
  let userLikes: string[] = memory.userLikes ? [...memory.userLikes] : [];
  let userDislikes: string[] = memory.userDislikes ? [...memory.userDislikes] : [];

  // Capture Telegram display name if not yet known
  if (fromName && !userName) userName = fromName;

  // "call me X" / "my name is X"
  const nameMatch = userText.match(/\b(?:call me|my name is)\s+([\w'-]{2,20})/i);
  if (nameMatch) userName = nameMatch[1].charAt(0).toUpperCase() + nameMatch[1].slice(1);

  // "I am X years old" / "I'm X years old"
  const ageMatch = userText.match(/\bi'?m\s+(\d{1,2})\s+years?\s+old/i) ??
                   userText.match(/\bi am\s+(\d{1,2})\s+years?\s+old/i) ??
                   userText.match(/\bmy age is\s+(\d{1,2})/i);
  if (ageMatch) {
    const age = parseInt(ageMatch[1], 10);
    if (age >= 3 && age <= 120) userAge = age;
  }

  // "I like/love/enjoy/prefer X" / "my favorite is X"
  const likesMatch = userText.match(/\b(?:i (?:like|love|enjoy|prefer|adore)|my favou?rite(?: is)?)\s+([^,.!?\n]{2,40})/i);
  if (likesMatch) {
    const liked = likesMatch[1].trim().toLowerCase();
    if (!userLikes.includes(liked)) userLikes = [...userLikes, liked].slice(-5);
  }

  // "I hate/dislike/can't stand/don't like X"
  const dislikesMatch = userText.match(/\b(?:i (?:hate|dislike|despise|can'?t stand)|i don'?t (?:like|enjoy))\s+([^,.!?\n]{2,40})/i);
  if (dislikesMatch) {
    const disliked = dislikesMatch[1].trim().toLowerCase();
    if (!userDislikes.includes(disliked)) userDislikes = [...userDislikes, disliked].slice(-5);
  }

  return {
    userName,
    userAge,
    userLikes: userLikes.length > 0 ? userLikes : undefined,
    userDislikes: userDislikes.length > 0 ? userDislikes : undefined,
  };
}

/** Build a system-prompt snippet personalising replies with known user info. */
function buildUserContext(
  userName: string | undefined,
  userAge: number | undefined,
  userLikes: string[] | undefined,
  userDislikes: string[] | undefined
): string {
  const parts: string[] = [];
  if (userName) parts.push(`The user's name is ${userName}. Only use their name very rarely — like a real friend texting, not every message. Most of the time just talk without using it.`);
  if (userAge) parts.push(`They are ${userAge} years old.`);
  if (userLikes && userLikes.length > 0) parts.push(`They've mentioned liking: ${userLikes.join(", ")}.`);
  if (userDislikes && userDislikes.length > 0) parts.push(`They've mentioned disliking: ${userDislikes.join(", ")}. Don't bring these up unless they do.`);
  return parts.join(" ");
}

/**
 * Single-model OpenRouter call with up to MAX_RETRIES_PER_MODEL retries and jittered backoff.
 * Respects the caller's deadline: clamps each attempt timeout and aborts early if budget runs out.
 * Returns { ok: true, content } on success or { ok: false, transient, fatal? } on failure.
 */
async function callOpenRouter(
  env: Env,
  model: string,
  messages: OpenRouterMessage[],
  deadline: number
): Promise<OrResult> {
  const SAFETY_MARGIN_MS = 1_000; // reserve 1 s so the caller can still reply

  for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
    if (attempt > 0) {
      // Bail before the sleep if budget is already gone
      if (Date.now() >= deadline - SAFETY_MARGIN_MS) {
        console.log("Budget exhausted before retry sleep", model);
        return { ok: false, transient: true };
      }
      await sleep(200 + Math.floor(Math.random() * 401)); // 200–600 ms jitter
    }

    // Clamp per-attempt timeout to remaining budget
    const remaining = deadline - Date.now() - SAFETY_MARGIN_MS;
    if (remaining <= 0) {
      console.log("Budget exhausted before fetch", model);
      return { ok: false, transient: true };
    }
    const attemptTimeout = Math.min(MODEL_TIMEOUT_MS, remaining);

    let resp: Response;
    let data: any = {};

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), attemptTimeout);
      try {
        resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": env.APP_URL || "https://example.com",
            "X-OpenRouter-Title": env.APP_NAME || "iCub Telegram Bot",
          },
          body: JSON.stringify({ model, messages, temperature: 0.8, top_p: 0.9, max_completion_tokens: 300 }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(tid);
      }
      data = await resp.json().catch(() => ({}));
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      console.log(isAbort ? "OpenRouter timeout" : "OpenRouter fetch error", model, "attempt", attempt, String(err));
      continue; // network/timeout — transient, retry
    }

    const errCode = Number(data?.error?.code ?? resp.status);
    const errText = String(data?.error?.metadata?.raw ?? data?.error?.message ?? "");

    if (!resp.ok) {
      if (FATAL_HTTP_CODES.has(errCode)) {
        console.log("OpenRouter FATAL auth/billing error", model, errCode);
        return { ok: false, transient: false, fatal: true };
      }
      if (SKIP_HTTP_CODES.has(errCode)) {
        console.log("OpenRouter skip (404)", model);
        return { ok: false, transient: false };
      }
      if (errCode === 400 && /Developer instruction is not enabled/i.test(errText)) {
        console.log("OpenRouter Gemma system-prompt rejection", model);
        return { ok: false, transient: false };
      }
      if (TRANSIENT_HTTP_CODES.has(errCode)) {
        console.log("OpenRouter transient", model, errCode, "attempt", attempt);
        continue;
      }
      console.log("OpenRouter non-transient error", model, errCode, data);
      return { ok: false, transient: false };
    }

    const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
    if (!content) {
      console.log("OpenRouter empty content", model, "attempt", attempt);
      continue; // treat as transient
    }

    console.log("OpenRouter success | model:", model, "| attempt:", attempt, "| status:", resp.status);
    return { ok: true, content };
  }

  return { ok: false, transient: true }; // all retries exhausted
}

/** callOpenRouter return type extended with optional fatal flag */
type OrResult = { ok: true; content: string } | { ok: false; transient: boolean; fatal?: boolean };

/**
 * Best-effort summarisation: only fires when turnCount has advanced by SUMMARY_EVERY_N
 * since the last summary, preventing a constant extra LLM call on every request.
 * Only the messages added SINCE the last summary are sent to the summariser to prevent drift.
 */
async function maybeSummarise(
  env: Env,
  history: ChatMessage[],
  memory: Pick<ChatMemory, "turnCount" | "lastSummarizedAt" | "summary">,
  deadline: number
): Promise<{ summary: string | undefined; lastSummarizedAt: number }> {
  const turnsSinceLast = (memory.turnCount ?? 0) - (memory.lastSummarizedAt ?? 0);
  if (turnsSinceLast < SUMMARY_EVERY_N) {
    return { summary: memory.summary, lastSummarizedAt: memory.lastSummarizedAt ?? 0 };
  }

  // Only summarise the NEW messages since the last summary to prevent drift
  // Each turn = 2 messages (user + assistant), so multiply by 2
  const newMessages = history.slice(-(turnsSinceLast * 2));
  const transcript = newMessages
    .map((m) => `${m.role === "user" ? "User" : "iCub"}: ${m.content}`)
    .join("\n");
  const prompt = memory.summary
    ? `Existing summary: ${memory.summary}\n\nNew exchanges:\n${transcript}\n\nUpdate the summary in 1–3 plain sentences. No markdown.`
    : `Summarise this conversation in 1–3 plain sentences. No markdown.\n\n${transcript}`;

  const model = MODELS_TO_TRY.find((m) => !isSystemlessModel(m)) ?? MODELS_TO_TRY[0];
  const result = await callOpenRouter(env, model, [
    { role: "system", content: "You are a concise summariser. Output 1–3 plain-text sentences only." },
    { role: "user", content: prompt },
  ], deadline).catch(() => null);

  const newSummary = result?.ok ? result.content.slice(0, 400) : memory.summary;
  return { summary: newSummary, lastSummarizedAt: memory.turnCount ?? 0 };
}

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OPENROUTER_API_KEY: string;
  WEBHOOK_SECRET: string;
  SETUP_SECRET: string;
  APP_NAME?: string;
  APP_URL?: string;
  // KV namespace for per-chat memory.
  // Create with: wrangler kv namespace create CHAT_MEMORY
  // Then paste the printed id into wrangler.jsonc.
  CHAT_MEMORY: KVNamespace;
}

type TelegramUpdate = {
  update_id?: number;
  message?: { chat?: { id?: number }; text?: string; from?: { first_name?: string; username?: string } };
  edited_message?: { chat?: { id?: number }; text?: string; from?: { first_name?: string; username?: string } };
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok");
    }

    // GET /setup?secret=<SETUP_SECRET>
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

    // POST /webhook
    if (request.method === "POST" && url.pathname === "/webhook") {
      // Verify Telegram's signed header
      const incoming = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (!incoming || incoming !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = (await request.json().catch(() => ({}))) as TelegramUpdate;

      // ── De-duplication via update_id ──────────────────────────────────────
      if (update.update_id != null) {
        const dedupeKey = `dedupe:${update.update_id}`;
        if (await env.CHAT_MEMORY.get(dedupeKey)) return new Response("ok", { status: 200 });
        await env.CHAT_MEMORY.put(dedupeKey, "1", { expirationTtl: DEDUPE_TTL }).catch(() => {});
      }

      const msg = update.message ?? update.edited_message;
      const chatId = msg?.chat?.id;
      const text = msg?.text?.trim();
      if (!chatId || !text) return new Response("ignored", { status: 200 });

      // ── /start ────────────────────────────────────────────────────────────
      if (text === "/start") {
        // Load existing memory so we can preserve user profile across resets
        let existingProfile: { userName?: string; userAge?: number; userLikes?: string[]; userDislikes?: string[] } = {};
        try {
          const stored = await env.CHAT_MEMORY.get(`chat:${chatId}`);
          if (stored) { const m = JSON.parse(stored); existingProfile = { userName: m.userName, userAge: m.userAge, userLikes: m.userLikes, userDislikes: m.userDislikes }; }
        } catch { /* ignore */ }
        // Capture name from /start sender if not yet known
        const startFrom = msg.from;
        const startName = startFrom?.first_name || startFrom?.username;
        const userName = existingProfile.userName || startName;
        // Write fresh memory preserving user profile
        const freshMemory: ChatMemory = {
          messages: [], turnCount: 0, lastSummarizedAt: 0, updatedAt: Date.now(),
          userName, userAge: existingProfile.userAge, userLikes: existingProfile.userLikes, userDislikes: existingProfile.userDislikes,
        };
        await env.CHAT_MEMORY.put(`chat:${chatId}`, JSON.stringify(freshMemory), { expirationTtl: KV_TTL }).catch(() => {});
        const greeting = userName
          ? `hey ${userName}! i'm iCub 🤖 what's up?`
          : "hey! i'm iCub 🤖 what's on your mind?";
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, greeting);
        return new Response("ok", { status: 200 });
      }

      // ── Load memory ───────────────────────────────────────────────────────
      let memory: ChatMemory = {
        messages: [], turnCount: 0, lastSummarizedAt: 0, updatedAt: Date.now(),
      };
      try {
        const stored = await env.CHAT_MEMORY.get(`chat:${chatId}`);
        if (stored) memory = { ...memory, ...JSON.parse(stored) };
      } catch { /* start fresh */ }

      const history = memory.messages ?? [];
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content;

      // ── User identity: extract/update name, age, likes & dislikes ──────────
      const fromName = msg.from?.first_name || msg.from?.username;
      const { userName, userAge, userLikes, userDislikes } = extractUserInfo(memory, fromName, text);

      // ── Typing indicator (best-effort, fire-and-forget) ───────────────────
      sendTypingAction(env.TELEGRAM_BOT_TOKEN, chatId);

      // ── Pending message recovery ──────────────────────────────────────────
      let pendingNotice: string | null = null;
      if (memory.pendingUser) {
        if (Date.now() - memory.pendingUser.at < PENDING_TTL_MS) {
          const snippet = memory.pendingUser.text.length > 60
            ? memory.pendingUser.text.slice(0, 60) + "…"
            : memory.pendingUser.text;
          pendingNotice = `Oops, I might have missed your last message: "${snippet}". Do you still want help with that?`;
        }
        memory.pendingUser = undefined; // clear regardless (expired or consumed)
      }

      // ── Ambiguity rewrite ─────────────────────────────────────────────────
      const textForModel = rewriteForClarity(text, lastAssistant);

      // ── Build ordered model list — sticky: try lastGoodModel first ────────
      const stickyModel = memory.lastGoodModel;
      const orderedModels = stickyModel
        ? [stickyModel, ...MODELS_TO_TRY.filter((m) => m !== stickyModel)]
        : MODELS_TO_TRY;

      // ── Total-budget deadline ─────────────────────────────────────────────
      const deadline = Date.now() + TOTAL_BUDGET_MS;

      // ── Model fallback loop ───────────────────────────────────────────────
      let reply: string | null = null;

      for (const model of orderedModels) {
        if (Date.now() >= deadline) {
          console.log("Total budget exceeded, stopping model loop");
          break;
        }
        const userCtx = buildUserContext(userName, userAge, userLikes, userDislikes);
        const messages = buildMessagesForModel(model, history, memory.summary, textForModel, userCtx || undefined);
        const result = await callOpenRouter(env, model, messages, deadline);

        // Fatal auth/billing error — stop the whole loop and give a friendly reply
        if (!result.ok && result.fatal) {
          reply = "I cannot think right now. Can we try again a little later?";
          break;
        }
        if (!result.ok) continue;

        reply = clampForTelegram(result.content || "Hmm, I did not quite get that. Can you say it again?");

        // Update history
        const updatedHistory: ChatMessage[] = [
          ...history,
          { role: "user" as const, content: text },
          { role: "assistant" as const, content: result.content },
        ].slice(-MAX_TURNS);

        const newTurnCount = (memory.turnCount ?? 0) + 1;

        // Summarisation + KV write are non-critical — defer via waitUntil so
        // the Telegram reply is not delayed by these async operations.
        ctx.waitUntil(
          (async () => {
            // Give summarisation a generous share of the remaining time (up to 20 s)
            const summariseDeadline = Date.now() + 20_000;
            const { summary, lastSummarizedAt } = await maybeSummarise(
              env, updatedHistory, { ...memory, turnCount: newTurnCount }, summariseDeadline
            ).catch(() => ({ summary: memory.summary, lastSummarizedAt: memory.lastSummarizedAt }));

            const newMemory: ChatMemory = {
              messages: updatedHistory,
              summary,
              turnCount: newTurnCount,
              lastSummarizedAt,
              lastGoodModel: model,
              pendingUser: undefined,
              userName,
              userAge,
              userLikes,
              userDislikes,
              updatedAt: Date.now(),
            };
            await env.CHAT_MEMORY.put(`chat:${chatId}`, JSON.stringify(newMemory), {
              expirationTtl: KV_TTL,
            }).catch(() => {});
          })()
        );

        break;
      }

      // ── All models failed — store pending + friendly fallback ─────────────
      if (!reply) {
        console.log("All models failed for chatId:", chatId);
        memory.pendingUser = { text, at: Date.now() };
        memory.userName = userName;
        memory.userAge = userAge;
        memory.userLikes = userLikes;
        memory.userDislikes = userDislikes;
        env.CHAT_MEMORY.put(`chat:${chatId}`, JSON.stringify(memory), {
          expirationTtl: KV_TTL,
        }).catch(() => {});
        reply = pickRandom(ICUB_FALLBACKS);
      }

      // ── Send (prepend pending notice if relevant) ─────────────────────────
      const finalReply = pendingNotice
        ? clampForTelegram(`${pendingNotice}\n\n${reply}`)
        : reply;

      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, finalReply);
      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};
