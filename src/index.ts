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
const JOKE_CANDIDATE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days — expire unconfirmed joke candidates
const JOKE_CANDIDATE_MAX = 20;  // max pending candidates per user

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

type ChatMessage = { role: "user" | "assistant"; content: string; ts?: number }; // ts = Unix seconds (Telegram date)
type UserConversationStyle = {
  usesEmojis: boolean | null;
  messageLength: string;  // "short" | "medium" | "long"
  tone: string;           // e.g. "playful"
};
type UserProfile = {
  userName?: string;
  userNickname?: string;
  userAge?: number;
  userLikes?: string[];
  userDislikes?: string[];
  userFavoriteTopics?: string[];
  userRelationshipStyle?: string;
  userInsideJokes?: string[];
  userJokeCandidates?: Record<string, [number, number]>; // phrase -> [count, first_seen_ms]; promoted at 2+
  userTrustLevel?: string;        // "friend" | "close_friend" (default: "friend")
  userLastPersonalUpdate?: string;
  userConversationStyle?: UserConversationStyle;
  userFirstTalked?: number;
  userLastTalked?: number;
  userUtcOffset?: number;         // UTC offset in hours (e.g. 1 for CET, -5 for EST)
};
type ChatMemory = {
  messages: ChatMessage[];
  summary?: string;
  turnCount: number;              // total successful turns ever stored
  lastSummarizedAt: number;       // turnCount value at last summary
  lastGoodModel?: string;         // most-recently-successful model — tried first next turn
  pendingUser?: { text: string; at: number };
  // user profile
  userName?: string;              // display name captured from Telegram or text patterns
  userNickname?: string;          // preferred nickname
  userAge?: number;               // age if the user mentioned it
  userLikes?: string[];           // up to 5 things the user mentioned liking
  userDislikes?: string[];        // up to 5 things the user mentioned disliking
  userFavoriteTopics?: string[];  // up to 5 topics the user is into
  userRelationshipStyle?: string; // e.g. "protective"
  userInsideJokes?: string[];     // shared inside jokes
  userJokeCandidates?: Record<string, [number, number]>; // phrase -> [count, first_seen_ms]
  userTrustLevel?: string;        // "friend" | "close_friend"
  userLastPersonalUpdate?: string;// e.g. "i have an exam tomorrow"
  userConversationStyle?: UserConversationStyle;
  userFirstTalked?: number;       // ms timestamp of first interaction
  userLastTalked?: number;        // ms timestamp of most recent interaction
  userUtcOffset?: number;         // UTC offset in hours, inferred from conversation
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

// ── Timezone / DST helpers ───────────────────────────────────────────────────
/** UTC ms of the last Sunday of `month` (0-indexed) in `year` at 00:00 UTC. */
function lastSundayUTC(year: number, month: number): number {
  const last = new Date(Date.UTC(year, month + 1, 0));
  last.setUTCDate(last.getUTCDate() - last.getUTCDay());
  return last.getTime();
}
/** UTC ms of the nth (1-based) Sunday of `month` (0-indexed) in `year` at 00:00 UTC. */
function nthSundayUTC(year: number, month: number, n: number): number {
  const d = new Date(Date.UTC(year, month, 1));
  const firstSunday = d.getUTCDay() === 0 ? 1 : 8 - d.getUTCDay();
  return Date.UTC(year, month, firstSunday + (n - 1) * 7);
}
/** EU CET/CEST — UTC+1 winter, UTC+2 summer. */
function getEUCETOffset(tsMs: number): number {
  const yr = new Date(tsMs).getUTCFullYear();
  return (tsMs >= lastSundayUTC(yr, 2) + 3_600_000 && tsMs < lastSundayUTC(yr, 9) + 3_600_000) ? 2 : 1;
}
/** UK / Ireland / Portugal — UTC+0 winter, UTC+1 summer. */
function getGMTBSTOffset(tsMs: number): number { return getEUCETOffset(tsMs) - 1; }
/** EET/EEST — UTC+2 winter, UTC+3 summer. */
function getEETOffset(tsMs: number): number { return getEUCETOffset(tsMs) + 1; }
/** US Eastern — UTC-5 / UTC-4. */
function getUSEastOffset(tsMs: number): number {
  const yr = new Date(tsMs).getUTCFullYear();
  return (tsMs >= nthSundayUTC(yr, 2, 2) + 7 * 3_600_000 && tsMs < nthSundayUTC(yr, 10, 1) + 6 * 3_600_000) ? -4 : -5;
}
function getUSCentralOffset(tsMs: number): number  { return getUSEastOffset(tsMs) - 1; }
function getUSMountainOffset(tsMs: number): number { return getUSEastOffset(tsMs) - 2; }
function getUSPacificOffset(tsMs: number): number  { return getUSEastOffset(tsMs) - 3; }
/** Australia Eastern — roughly UTC+11 Oct–Mar (AEDT), UTC+10 Apr–Sep (AEST). */
function getAESTOffset(tsMs: number): number {
  const m = new Date(tsMs).getUTCMonth();
  return (m >= 9 || m <= 2) ? 11 : 10;
}
/** New Zealand — roughly UTC+13 Sep–Apr (NZDT), UTC+12 Apr–Sep (NZST). */
function getNZOffset(tsMs: number): number {
  const m = new Date(tsMs).getUTCMonth();
  return (m >= 8 || m <= 3) ? 13 : 12;
}

type OffsetResolver = number | ((tsMs: number) => number);
/** City / country → UTC offset resolver. First regex match wins. */
const LOCATION_TZ_MAP: Array<[RegExp, OffsetResolver]> = [
  // EU CET/CEST (+1/+2)
  [/\b(?:italy|italian|rome|milan|naples|turin|venice|florence|sicily|sardinia|palermo|bologna)\b/i, getEUCETOffset],
  [/\b(?:germany|german|berlin|munich|hamburg|frankfurt|cologne|stuttgart|dusseldorf)\b/i, getEUCETOffset],
  [/\b(?:france|french|paris|lyon|marseille|toulouse|nice|bordeaux|strasbourg)\b/i, getEUCETOffset],
  [/\b(?:spain|spanish|madrid|barcelona|seville|valencia|bilbao|malaga|zaragoza)\b/i, getEUCETOffset],
  [/\b(?:netherlands|dutch|amsterdam|rotterdam|the\s+hague|eindhoven|utrecht)\b/i, getEUCETOffset],
  [/\b(?:belgium|brussels|antwerp|ghent|bruges)\b/i, getEUCETOffset],
  [/\b(?:sweden|stockholm|norway|oslo|denmark|copenhagen)\b/i, getEUCETOffset],
  [/\b(?:switzerland|zurich|geneva|bern|lausanne|basel)\b/i, getEUCETOffset],
  [/\b(?:austria|vienna|graz|salzburg|innsbruck)\b/i, getEUCETOffset],
  [/\b(?:poland|warsaw|krakow|czech|prague|slovakia|bratislava|hungary|budapest)\b/i, getEUCETOffset],
  [/\b(?:croatia|zagreb|slovenia|serbia|belgrade|albania|bosnia|sarajevo|montenegro)\b/i, getEUCETOffset],
  // GMT/BST (+0/+1)
  [/\b(?:uk|united\s+kingdom|england|britain|british|london|manchester|birmingham|leeds|glasgow|edinburgh)\b/i, getGMTBSTOffset],
  [/\b(?:ireland|irish|dublin|cork|galway)\b/i, getGMTBSTOffset],
  [/\b(?:portugal|portuguese|lisbon|porto)\b/i, getGMTBSTOffset],
  // EET/EEST (+2/+3)
  [/\b(?:greece|greek|athens|thessaloniki)\b/i, getEETOffset],
  [/\b(?:romania|bucharest|bulgaria|sofia|cyprus|nicosia|ukraine|kyiv|kiev)\b/i, getEETOffset],
  [/\b(?:finland|helsinki|estonia|latvia|riga|lithuania|vilnius)\b/i, getEETOffset],
  // Static Europe
  [/\b(?:turkey|turkish|istanbul|ankara|izmir)\b/i, 3],
  [/\b(?:russia|moscow|saint\s+petersburg|st\.?\s*petersburg)\b/i, 3],
  [/\b(?:israel|tel\s+aviv|jerusalem|haifa)\b/i, 2],
  // Middle East
  [/\b(?:uae|dubai|abu\s+dhabi|united\s+arab\s+emirates)\b/i, 4],
  [/\b(?:saudi(?:\s+arabia)?|riyadh|jeddah|mecca)\b/i, 3],
  [/\b(?:qatar|doha|kuwait|bahrain|iraq|baghdad)\b/i, 3],
  [/\b(?:iran|tehran)\b/i, 3.5],
  [/\b(?:egypt|cairo|alexandria)\b/i, 2],
  // Asia
  [/\b(?:india|indian|mumbai|delhi|new\s+delhi|bangalore|bengaluru|hyderabad|chennai|kolkata|pune|ahmedabad)\b/i, 5.5],
  [/\b(?:pakistan|karachi|lahore|islamabad)\b/i, 5],
  [/\b(?:bangladesh|dhaka)\b/i, 6],
  [/\b(?:nepal|kathmandu)\b/i, 5.75],
  [/\b(?:china|chinese|beijing|shanghai|shenzhen|guangzhou|hong\s+kong|macau|taipei|taiwan)\b/i, 8],
  [/\b(?:japan|japanese|tokyo|osaka|kyoto|yokohama|nagoya|hiroshima)\b/i, 9],
  [/\b(?:(?:south\s+)?korea|korean|seoul|busan|incheon)\b/i, 9],
  [/\b(?:singapore|malaysia|kuala\s+lumpur|philippines|manila)\b/i, 8],
  [/\b(?:indonesia|jakarta|bali)\b/i, 7],
  [/\b(?:thailand|thai|bangkok)\b/i, 7],
  [/\b(?:vietnam|vietnamese|hanoi|ho\s+chi\s+minh|saigon)\b/i, 7],
  // Africa
  [/\b(?:south\s+africa|johannesburg|cape\s+town|durban|pretoria)\b/i, 2],
  [/\b(?:nigeria|lagos|abuja)\b/i, 1],
  [/\b(?:kenya|nairobi)\b/i, 3],
  [/\b(?:morocco|casablanca|rabat|tunisia|tunis|algeria|algiers)\b/i, 1],
  // Americas — US / Canada
  [/\b(?:new\s+york|nyc|boston|miami|atlanta|washington\s*d\.?c\.?|philadelphia|toronto|montreal|ottawa|eastern\s+time|est\b|edt\b)\b/i, getUSEastOffset],
  [/\b(?:chicago|houston|dallas|austin|minneapolis|cst\b|cdt\b|central\s+time)\b/i, getUSCentralOffset],
  [/\b(?:denver|phoenix|salt\s+lake|calgary|edmonton|mst\b|mdt\b|mountain\s+time)\b/i, getUSMountainOffset],
  [/\b(?:los\s+angeles|san\s+francisco|seattle|portland|las\s+vegas|california|vancouver|pst\b|pdt\b|pacific\s+time)\b/i, getUSPacificOffset],
  [/\b(?:hawaii|honolulu)\b/i, -10],
  // Americas — South
  [/\b(?:brazil|brazilian|s[aã]o\s+paulo|rio\b|bras[ií]lia)\b/i, -3],
  [/\b(?:argentina|buenos\s+aires|chile|santiago)\b/i, -3],
  [/\b(?:colombia|bogot[aá]|peru|lima|ecuador|quito)\b/i, -5],
  [/\b(?:mexico\s+city|cdmx)\b/i, getUSCentralOffset],
  // Oceania
  [/\b(?:sydney|melbourne|brisbane|canberra|adelaide)\b/i, getAESTOffset],
  [/\b(?:perth|western\s+australia)\b/i, 8],
  [/\b(?:new\s+zealand|auckland|wellington|christchurch)\b/i, getNZOffset],
];

/**
 * Format a Unix-seconds timestamp into a human-readable local time string,
 * using the provided UTC offset. e.g. "Tuesday night (11:42 PM UTC+01:00)"
 */
function formatMessageTime(unixSec: number, utcOffset: number): string {
  // Shift timestamp so UTC methods reflect local time
  const localMs = (unixSec + utcOffset * 3600) * 1000;
  const d = new Date(localMs);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[d.getUTCDay()];
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  const mStr = m.toString().padStart(2, "0");
  const sign = utcOffset >= 0 ? "+" : "-";
  const absOfs = Math.abs(utcOffset);
  const ofsH = Math.floor(absOfs).toString().padStart(2, "0");
  const ofsM = Math.round((absOfs % 1) * 60).toString().padStart(2, "0");
  const tzLabel = `UTC${sign}${ofsH}:${ofsM}`;
  let period: string;
  if (h >= 5 && h < 12) period = "morning";
  else if (h >= 12 && h < 17) period = "afternoon";
  else if (h >= 17 && h < 21) period = "evening";
  else period = "night";
  return `${dayName} ${period} (${h12}:${mStr} ${ampm} ${tzLabel})`;
}

/**
 * Return a human-readable relative-time string for use inside the model context.
 * e.g. "just now", "5 min ago", "yesterday", "3 days ago", "2 weeks ago"
 */
function formatRelativeTime(tsMs: number, nowMs: number): string {
  const diff = nowMs - tsMs;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60)  return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60)  return `${min} min ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 7)  return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
}

/**
 * Return a compact exact local datetime string for history annotations.
 * e.g. "Mon 09 Mar 2026, 11:42 PM"
 */
function formatExactTime(unixSec: number, utcOffset: number): string {
  const localMs = (unixSec + utcOffset * 3600) * 1000;
  const d = new Date(localMs);
  const days  = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dayName = days[d.getUTCDay()];
  const dd  = d.getUTCDate().toString().padStart(2, "0");
  const mon = months[d.getUTCMonth()];
  const yr  = d.getUTCFullYear();
  const h   = d.getUTCHours();
  const m   = d.getUTCMinutes().toString().padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  const h12  = (h % 12 || 12).toString();
  return `${dayName} ${dd} ${mon} ${yr}, ${h12}:${m} ${ampm}`;
}

/** Build the message array for a given model, injecting summary and context window. */
function buildMessagesForModel(
  model: string,
  history: ChatMessage[],
  summary: string | undefined,
  userText: string,
  utcOffset: number,
  userContext?: string
): OpenRouterMessage[] {
  const now = Date.now();
  const rawCtx = history.slice(-CONTEXT_WINDOW);

  // Prefix each history message with exact date/time + relative age so the model
  // knows precisely when each exchange happened.
  // e.g. "[Mon 06 Mar 2026, 11:42 PM — 3 days ago]"
  const annotate = (m: ChatMessage): OpenRouterMessage => ({
    role: m.role,
    content: (m.ts
      ? `[${formatExactTime(m.ts, utcOffset)} — ${formatRelativeTime(m.ts * 1000, now)}] `
      : "") + m.content,
  });

  if (!isSystemlessModel(model)) {
    const msgs: OpenRouterMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
    if (userContext) msgs.push({ role: "system", content: userContext });
    if (summary) msgs.push({ role: "system", content: `Summary so far: ${summary}` });
    msgs.push(...rawCtx.map(annotate), { role: "user", content: userText });
    return msgs;
  }

  // Gemma/systemless: fold system prompt + summary + transcript into one user message
  const transcript = rawCtx
    .map((m) => {
      const tag = m.ts
        ? ` [${formatExactTime(m.ts, utcOffset)} — ${formatRelativeTime(m.ts * 1000, now)}]`
        : "";
      return `${m.role === "user" ? "User" : "iCub"}${tag}: ${m.content}`;
    })
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
 * Normalize casual chat text for robust regex matching.
 * - Converts smart/curly apostrophes and similar chars to ASCII ' so regex i'?m works on phone input
 * - Collapses 3+ repeated characters ('loooove' → 'love')
 * - Collapses multiple whitespace into a single space
 */
function normalizeForMatching(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'") // smart/curly apostrophes → straight ASCII
    .replace(/[\u201C\u201D]/g, '"')              // smart double quotes → straight ASCII
    .replace(/(.)(\1){2,}/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
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
 * Extract / update the full user profile from Telegram sender metadata and message text.
 * Captures: name, nickname, age, likes, dislikes, favorite topics, relationship style,
 * inside jokes, trust level, last personal update, conversation style, and timestamps.
 */
function extractUserInfo(
  memory: ChatMemory,
  fromName: string | undefined,
  userText: string,
  msgTimestamp?: number
): UserProfile {
  const now = Date.now();

  let userName = memory.userName;
  let userNickname = memory.userNickname;
  let userAge = memory.userAge;
  let userLikes: string[] = memory.userLikes ? [...memory.userLikes] : [];
  let userDislikes: string[] = memory.userDislikes ? [...memory.userDislikes] : [];
  let userFavoriteTopics: string[] = memory.userFavoriteTopics ? [...memory.userFavoriteTopics] : [];
  let userRelationshipStyle = memory.userRelationshipStyle;
  const userInsideJokes: string[] = memory.userInsideJokes ? [...memory.userInsideJokes] : [];
  const jokeCandidates: Record<string, [number, number]> = memory.userJokeCandidates
    ? { ...memory.userJokeCandidates }
    : {};
  let userTrustLevel = memory.userTrustLevel ?? "friend";
  let userLastPersonalUpdate = memory.userLastPersonalUpdate;
  const userConversationStyle: UserConversationStyle = memory.userConversationStyle
    ? { ...memory.userConversationStyle }
    : { usesEmojis: null, messageLength: "", tone: "" };
  const userFirstTalked = memory.userFirstTalked ?? now;
  const userLastTalked = now;
  let userUtcOffset: number | undefined = memory.userUtcOffset;

  // Capture Telegram display name if not yet known
  if (fromName && !userName) userName = fromName;

  if (userText) {
    // ── Helpers ──────────────────────────────────────────────────────────────
    // Normalise once so all patterns work on collapsed text
    const norm = normalizeForMatching(userText);

    // Strip leading/trailing filler from a regex capture and lowercase it.
    const cleanPhrase = (s: string, maxLen = 40): string =>
      s.trim()
        .replace(/^(?:to be |to |being |about |like |basically |kinda |kind of |sort of |um+ |uh+ |well |so |just |really |lowkey |highkey )/i, "")
        .replace(/\s+(?:a lot|very much|so much|too|also|btw|tho|though|actually|honestly|ngl|tbh|lol|haha|hehe|rn|fr|frfr|no cap|ong|lowkey|highkey|deadass|bruh|and (?:stuff|things)|or (?:whatever|something|smth)|you know|idk|imo|i guess|i think)\s*$/i, "")
        .trim()
        .replace(/[!.,;:?]+$/, "")
        .trim()
        .toLowerCase()
        .slice(0, maxLen);

    const addUnique = (arr: string[], val: string, max: number): string[] => {
      const v = cleanPhrase(val);
      if (!v || v.length < 2 || /^(?:you|me|it|him|her|us|that|this|them|those|these|everyone|anyone|someone|nobody|everything|nothing|stuff|things|a|an|the|i|to|for|and|or|so|but|my|your)$/.test(v)) return arr;
      if (arr.includes(v)) return arr;
      return [...arr, v].slice(-max);
    };

    const isMeaningful = (s: string, minLen = 2): boolean => {
      if (!s || s.trim().length < minLen) return false;
      const STOPWORDS = new Set(["a","an","the","it","this","that","them","things","stuff",
        "something","everything","anything","i","me","to","for","and","or","so","but","my","your"]);
      return !STOPWORDS.has(s.trim().toLowerCase());
    };

    // ── Nickname — checked FIRST so it doesn't also fire the name rule ────────
    const nickMatch = norm.match(
      /\b(?:you can call me|my friends call me|everyone calls me|people call me|just call me|my nickname is|my nick is)\s+([\w'-]{2,20})\b/i
    );
    if (nickMatch) {
      userNickname = nickMatch[1].toLowerCase();
    } else {
      // ── Name ──────────────────────────────────────────────────────────────
      // "my name is/my name's/call me/i go by/i'm called/i am called/they call me/the name's X"
      const nameMatch = norm.match(
        /\b(?:my name'?s|my name is|call me|i go by|i'?m called|i am called|they call me|the name'?s)\s+([\w'-]{2,20})\b/i
      );
      if (nameMatch) {
        const n = nameMatch[1];
        userName = n.charAt(0).toUpperCase() + n.slice(1);
      }
    }

    // ── Age ───────────────────────────────────────────────────────────────────
    // Negative lookahead excludes ordinals and measurement units (min, km, %, etc.)
    // Allows up to 3 digits (capped to 120 later); matches "i'm 23", "my age is 30",
    // "i've just turned 18", "turning 25 soon", "i'll be 21 next year", "im 14 yo".
    const ageMatch =
      norm.match(/\b(?:i'?m|i\s+am)\s+(\d{1,3})\b(?:\s+y(?:ea)?rs?(?:\s+old)?\b)?(?!\s*(?:st|nd|rd|th|min(?:ute)?s?|hours?|hrs?|sec(?:ond)?s?|days?|weeks?|months?|km|miles?|meters?|percent|%|kg|lbs?|cm|mm|pm|am)\b)/i) ??
      norm.match(/\bmy\s+age\s+is\s+(\d{1,3})\b/i) ??
      norm.match(/\bi(?:'?ve)?\s+just\s+turned\s+(\d{1,3})\b/i) ??
      norm.match(/\bi\s+(?:just\s+)?turned\s+(\d{1,3})\b/i) ??
      norm.match(/\b(?:i'?m\s+)?turning\s+(\d{1,3})\s+(?:soon|next|this|tomorrow)\b/i) ??
      norm.match(/\bi(?:'?l+|\s+wil+)\s+be\s+(\d{1,3})\s+(?:soon|next|this|tomorrow)\b/i) ??
      norm.match(/\bi'?m\s+(\d{1,3})\s*yo\b/i) ??
      norm.match(/\bi'?m\s+(?:almost|nearly|about\s+to\s+(?:be|turn))\s+(\d{1,3})\b/i) ??
      norm.match(/\bi'?ll\s+be\s+(\d{1,3})\b/i);
    if (ageMatch) {
      const age = parseInt(ageMatch[1], 10);
      if (age >= 5 && age <= 120) userAge = age;
    }

    // ── Likes ─────────────────────────────────────────────────────────────────
    // "i (really) like/love/enjoy/prefer/adore/dig X", "i'm a big fan of X",
    // "i'm obsessed with X", "i'm addicted to X", "can't get enough of X",
    // "my favourite (is|one is|thing is) X"
    const likesMatch = norm.match(
      /\b(?:i\s+(?:(?:really|rlly|rly|absolutely|totally|kinda|lowkey|highkey|sorta|literally|genuinely|actually|seriously|deadass|so)\s+)?(?:like|liek|love|luv|enjoy|prefer|adore|dig)|my\s+favou?rite(?:\s+(?:is|one\s+is|thing\s+is))?|(?:i'?m|im)\s+(?:a\s+(?:huge|big)\s+fan\s+of|obsessed\s+w(?:ith)?|addicted\s+to|in\s+love\s+w(?:ith)?)|(?:i\s+)?can'?t\s+get\s+enough\s+of)\s+([^,.!?\n]{2,40})/i
    );
    if (likesMatch) userLikes = addUnique(userLikes, likesMatch[1], 5);

    // ── Dislikes ──────────────────────────────────────────────────────────────
    // "i (really) hate/dislike/despise/can't stand X", "i don't like X",
    // "not a fan of X", "i've never liked X", "pls don't talk about X"
    const dislikesMatch = norm.match(
      /\b(?:i\s+(?:(?:really|rlly|rly|honestly|literally|seriously|lowkey|kinda|actually|deadass)\s+)?(?:hate|dislike|despise|cannot\s+stand|can'?t\s+stand|cant\s+stand)|i\s+(?:don'?t|do\s+not|dont)\s+(?:(?:really|rlly|rly)\s+)?(?:like|liek|love|luv|enjoy|want|care\s+(?:for|about))|(?:(?:i'?m|im)\s+)?not\s+(?:(?:really|rlly|rly)\s+)?(?:a\s+(?:big\s+)?fan\s+of|into|feeling)|i(?:'ve|\s+have)?\s+never\s+(?:(?:really|rlly)\s+)?liked?|(?:pls\s+|please\s+)?(?:don'?t|dont|do\s+not)\s+(?:talk|ask|mention|bring\s+up)(?:\s+(?:about|me\s+about))?)\s+([^,.!?\n]{2,40})/i
    );
    if (dislikesMatch) userDislikes = addUnique(userDislikes, dislikesMatch[1], 5);

    // ── Favorite topics ───────────────────────────────────────────────────────
    // "i'm (really) into X", "i love talking about X", "my favourite thing is X",
    // "i'm passionate about X", "i'm big on X", "i nerd out about/on/over X",
    // "i (really) enjoy talking about X"
    const topicMatch = norm.match(
      /\b(?:(?:i'?m|im)\s+(?:(?:really|rlly|rly|so|super|lowkey|highkey)\s+)?into|i\s+am\s+(?:(?:really|rlly|rly|so|super)\s+)?into|i\s+(?:really\s+)?love\s+talking\s+about|my\s+favou?rite\s+thing(?:\s+to\s+talk\s+about)?\s+is|(?:i'?m|im)\s+obsessed\s+with|i\s+(?:really\s+)?enjoy\s+talking\s+about|(?:i'?m|im)\s+(?:(?:really|rlly|rly)\s+)?(?:big|huge)\s+on|(?:(?:i'?m|im)\s+)?passionate\s+about|i\s+nerd\s+out\s+(?:about|on|over))\s+([^,.!?\n]{2,40})/i
    );
    if (topicMatch) userFavoriteTopics = addUnique(userFavoriteTopics, topicMatch[1], 5);

    // ── Life / status updates ─────────────────────────────────────────────────
    // Broadly captures status, health, school, work, sleep, travel, mood, and life events.
    const lifeMatch = norm.match(
      /\b(?:i'?(?:ve|\s+have)\s+(?:got\s+)?(?:an?\s+)?(?:exam|test|deadline|meeting|job\s+interview|interview|cold|flu|covid|headache|fever|migraine|appointment|date|presentation|demo)|i'?m\s+(?:sick|ill|not\s+feeling\s+well|tired|exhausted|stressed|depressed|sad|happy|excited|nervous|anxious|bored|lonely|busy|free|drunk|injured|pregnant|engaged|married|single|at\s+work|at\s+school|at\s+uni(?:versity)?|at\s+college|at\s+home|at\s+the\s+(?:gym|hospital|doctor'?s?|dentist'?s?|airport|beach|park|office|library|store|mall)|travel(?:l?ing)|on\s+(?:vacation|holiday|a\s+trip)|going\s+to\s+(?:sleep|bed|work|school)|heading\s+(?:to\s+(?:bed|work|school)|home|out)|running\s+late|late\s+today|free\s+today|moving(?:\s+(?:house|out|away))?|cooking|studying|cramming|working\s+out|hungover|on\s+my\s+way|about\s+to\s+(?:leave|sleep|eat|go))|i\s+am\s+(?:sick|ill|not\s+feeling\s+well|tired|exhausted|stressed|depressed|sad|happy|excited|nervous|anxious|bored|lonely|busy|free|at\s+work|at\s+school|at\s+uni(?:versity)?|at\s+college|at\s+home|travel(?:l?ing)|on\s+(?:vacation|holiday|a\s+trip))|i\s+just\s+(?:got\s+(?:home|back|fired|hired|promoted|married|dumped|engaged|divorced)|woke\s+up|finished|graduated|started|moved|broke\s+up|had\s+a\s+baby)|today\s+is\s+my\s+birthday|it'?s\s+my\s+birthday|i\s+(?:just\s+)?broke\s+(?:my|a)\s+\w+|i\s+(?:lost|found)\s+my\s+(?:job|phone|wallet|keys)|can'?t\s+sleep|going\s+to\s+(?:bed|sleep)|just\s+woke\s+up|studying|running\s+late)\b[^.!?\n]{0,60}/i
    );
    if (lifeMatch) userLastPersonalUpdate = lifeMatch[0].trim().toLowerCase();

    // ── Conversation style — emoji usage ──────────────────────────────────────
    // \p{Extended_Pictographic} covers the full graphical emoji set in V8/CF Workers
    if (userConversationStyle.usesEmojis !== true && /\p{Extended_Pictographic}/u.test(userText)) {
      userConversationStyle.usesEmojis = true;
    }

    // ── Conversation style — message length ───────────────────────────────────
    const msgLen = userText.length;
    userConversationStyle.messageLength = msgLen < 25 ? "short" : msgLen > 120 ? "long" : "medium";

    // ── Conversation style — tone ─────────────────────────────────────────────
    // Handles elongated laughs (hahaha, hehehe), slang (bruh, omg, ikr, fr fr, xD)
    // Note: emoji checked separately since \b doesn't work on emoji chars
    if (/(?:\b(?:lol+|lmao+|lmfao|rofl|omg|ikr|bruh)\b|\bfr\s+fr\b|\bha(?:ha)+h?\b|\bhe(?:he)+h?\b|[xX]+[dD]+(?:\b|$)|\bi'?m\s+(?:dead|dying|crying)\b|😂|😭|🤣|💀)/i.test(norm)) {
      userConversationStyle.tone = "playful";
    }

    // ── Relationship style ────────────────────────────────────────────────────
    // Catches caring/protective language: "poor icub", "are you okay", "awww",
    // "hang in there", "i feel bad for you", "take care", "feel better", etc.
    if (/(?:\b(?:poor\s+(?:i[- ]?cub|thing|baby|robot|lil|little(?:\s+guy)?)|are\s+you\s+(?:ok|okay|alright)|(?:i'?ll|ill|i\s+will|i\s+can|i'?d(?:\s+love\s+to)?)\s+(?:come\s+)?feed\s+you|is\s+someone\s+feeding\s+you|don'?t\s+worry(?:\s+about\s+it)?|hope\s+you(?:'re|\s+are)\s+(?:ok|okay|alright)|wish\s+i\s+could\s+(?:help|be\s+there|feed\s+you)|i(?:'d|\s+would)\s+come|i\s+want\s+to\s+(?:help|feed\s+you)|hang\s+in\s+there|stay\s+strong|i\s+feel\s+(?:bad|sorry)\s+for\s+you|that(?:'s|\s+is)\s+so\s+sad|take\s+care(?:\s+of\s+yourself)?|feel\s+better)\b|\baww+\b|(?:\boh\s+no\b|\baww+\b),?\s*(?:poor|are\s+you\s+ok))/i.test(norm)) {
      userRelationshipStyle = "protective";
    }

    // ── Inside jokes ──────────────────────────────────────────────────────────
    // Catches explicit shared-memory references:
    // "remember when we/you X", "that's our joke/thing",
    // "haha the X thing", "we always say X", "like that time we X"
    // A phrase must be mentioned 2+ times before it is confirmed as an inside joke.
    const jokeMatch = norm.match(
      /\b(?:remember\s+(?:when\s+(?:we|you)|that\s+time\s+(?:we|you)|the\s+time\s+(?:we|you)))\s+([^.!?\n]{3,60})|(?:that'?s\s+(?:our|an?)\s+(?:inside\s+)?(?:joke|thing)|our\s+inside\s+joke)\b[:\s]*([^.!?\n]{0,60})|(?:(?:lol|haha|lmao|hehe)\s+)the\s+([\w\s'-]{3,40})\s+thing\b|we\s+always\s+(?:say|do|call\s+(?:it|that))\s+([^.!?\n]{3,50})|like\s+that\s+time\s+(?:when\s+)?(?:we|you)\s+([^.!?\n]{3,60})/i
    );
    if (jokeMatch) {
      const rawJoke = jokeMatch.slice(1).find((g) => g != null) ?? null;
      if (rawJoke) {
        const joke = cleanPhrase(rawJoke, 80);
        if (isMeaningful(joke, 3)) {
          // Migrate old int-valued candidates (count only) to [count, ts]
          for (const k of Object.keys(jokeCandidates)) {
            const v = jokeCandidates[k];
            if (typeof v === "number") jokeCandidates[k] = [v as unknown as number, now];
          }

          // Prune expired candidates
          for (const k of Object.keys(jokeCandidates)) {
            if (now - jokeCandidates[k][1] > JOKE_CANDIDATE_TTL_MS) delete jokeCandidates[k];
          }

          // Only store as a confirmed inside joke after 2+ references
          if (!userInsideJokes.some((j) => joke.includes(j) || j.includes(joke))) {
            const existingKey = Object.keys(jokeCandidates).find(
              (k) => joke.includes(k) || k.includes(joke)
            ) ?? null;
            if (existingKey !== null) {
              jokeCandidates[existingKey][0] += 1;
              if (jokeCandidates[existingKey][0] >= 2) {
                userInsideJokes.push(existingKey);
                delete jokeCandidates[existingKey];
                if (userInsideJokes.length > 5) userInsideJokes.shift();
              }
            } else {
              // Enforce size cap: drop oldest candidate by first-seen timestamp
              if (Object.keys(jokeCandidates).length >= JOKE_CANDIDATE_MAX) {
                const oldest = Object.keys(jokeCandidates).reduce((a, b) =>
                  jokeCandidates[a][1] < jokeCandidates[b][1] ? a : b
                );
                delete jokeCandidates[oldest];
              }
              jokeCandidates[joke] = [1, now]; // first mention — wait for recurrence
            }
          }
        }
      }
    }

    // ── Trust level ───────────────────────────────────────────────────────────
    // Escalates to "close_friend" on explicit trust signals: confiding, sharing secrets,
    // declaring closeness, or expressing deep emotional comfort.
    const TRUST_RANK: Record<string, number> = { friend: 0, close_friend: 1 };
    if ((TRUST_RANK[userTrustLevel] ?? 0) < TRUST_RANK["close_friend"]) {
      if (/\b(?:i\s+(?:really\s+)?trust\s+you|i\s+can\s+trust\s+you|you'?re\s+(?:the\s+)?only\s+(?:one|person)\s+i\s+(?:can\s+)?(?:talk|open\s+up|vent)\s+to|i\s+feel\s+(?:so\s+)?(?:comfortable|safe|at\s+ease)\s+(?:with\s+you|talking\s+to\s+you)|i'?ve\s+never\s+told\s+(?:anyone|anybody)(?:\s+(?:this|before|else))?|nobody\s+(?:else\s+)?knows\s+(?:this|about\s+this)|(?:don'?t|pls\s+don'?t|please?\s+don'?t)\s+tell\s+(?:anyone|anybody)|(?:this|it)\s+(?:is|stays?)\s+between\s+us|keep\s+(?:this|it)\s+between\s+us|(?:this\s+is|it'?s)\s+a\s+secret|you'?re\s+(?:my\s+)?(?:best|closest)\s+friend|i\s+(?:can|could)\s+tell\s+you\s+(?:anything|everything)|you\s+(?:really\s+)?(?:get|understand)\s+me|(?:you'?re\s+)?the\s+only\s+(?:one|person)\s+(?:who|that)\s+(?:gets|understands)\s+me|i\s+(?:really\s+)?(?:lo+ve|appreciate)\s+talking\s+to\s+you|you\s+mean\s+(?:a\s+lot|so\s+much|everything)\s+to\s+me|i\s+don'?t\s+know\s+what\s+i'?d\s+do\s+without\s+you)\b/i.test(norm)) {
        userTrustLevel = "close_friend";
      }
    }

    // ── Timezone detection ────────────────────────────────────────────────────
    // 1. Explicit UTC/GMT offset: "UTC+2", "GMT-5", "UTC+5:30"
    const utcOffsetMatch = norm.match(/\b(?:utc|gmt)\s*([+-])\s*(\d{1,2})(?::(\d{2}))?\b/i);
    if (utcOffsetMatch) {
      const sign = utcOffsetMatch[1] === "+" ? 1 : -1;
      const hrs  = parseInt(utcOffsetMatch[2], 10);
      const mins = parseInt(utcOffsetMatch[3] ?? "0", 10);
      const ofs  = sign * (hrs + mins / 60);
      if (ofs >= -12 && ofs <= 14) userUtcOffset = Math.round(ofs * 2) / 2;
    }

    // 2. "it's X am/pm here" → infer offset from message send time
    if (userUtcOffset === undefined && msgTimestamp) {
      const tHereMatch = norm.match(
        /\bit'?s\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s+(?:here|for\s+me|over\s+here|atm|right\s+now)\b/i
      );
      if (tHereMatch) {
        let lh = parseInt(tHereMatch[1], 10);
        const ap = tHereMatch[3].toLowerCase();
        if (ap === "pm" && lh < 12) lh += 12;
        if (ap === "am" && lh === 12) lh = 0;
        const utcH = new Date(msgTimestamp * 1000).getUTCHours();
        let diff = lh - utcH;
        if (diff > 14) diff -= 24;
        if (diff < -12) diff += 24;
        userUtcOffset = Math.round(diff * 2) / 2;
      }
    }

    // 3. City / country name → lookup table
    if (userUtcOffset === undefined && msgTimestamp) {
      for (const [re, ofsFn] of LOCATION_TZ_MAP) {
        if (re.test(norm)) {
          userUtcOffset = typeof ofsFn === "function" ? ofsFn(msgTimestamp * 1000) : ofsFn;
          break;
        }
      }
    }
  }

  return {
    userName,
    userNickname,
    userAge,
    userLikes: userLikes.length > 0 ? userLikes : undefined,
    userDislikes: userDislikes.length > 0 ? userDislikes : undefined,
    userFavoriteTopics: userFavoriteTopics.length > 0 ? userFavoriteTopics : undefined,
    userRelationshipStyle,
    userInsideJokes: userInsideJokes.length > 0 ? userInsideJokes : undefined,
    userJokeCandidates: Object.keys(jokeCandidates).length > 0 ? jokeCandidates : undefined,
    userTrustLevel,
    userLastPersonalUpdate,
    userConversationStyle,
    userFirstTalked,
    userLastTalked,
    userUtcOffset,
  };
}

/** Build a system-prompt snippet personalising replies with known user info. */
function buildUserContext(profile: UserProfile): string {
  const safeStr = (v: unknown, maxLen = 60): string => {
    if (!v || typeof v !== "string") return "";
    return v.replace(/\s+/g, " ").trim().slice(0, maxLen);
  };
  const safeList = (v: unknown, max = 5): string[] => {
    if (!Array.isArray(v)) return [];
    return (v as unknown[]).map((s) => safeStr(s)).filter(Boolean).slice(0, max);
  };

  const parts: string[] = [];

  const name = safeStr(profile.userName);
  const nickname = safeStr(profile.userNickname);
  if (name) {
    let nameStr = `Name: ${name}.`;
    if (nickname) nameStr += ` Nickname: ${nickname}.`;
    parts.push(nameStr);
  }

  if (profile.userAge) parts.push(`Age: ${profile.userAge}.`);

  // merge favorite_topics + likes (topics first, deduplicated)
  const topics = safeList(profile.userFavoriteTopics);
  const likes = safeList(profile.userLikes);
  const allInterests = [...new Set([...topics, ...likes])].slice(0, 5);
  if (allInterests.length > 0) parts.push(`Likes: ${allInterests.join(", ")}.`);

  const dislikes = safeList(profile.userDislikes, 3);
  if (dislikes.length > 0) parts.push(`Dislikes: ${dislikes.join(", ")}.`);

  const relStyle = safeStr(profile.userRelationshipStyle);
  if (relStyle) parts.push(`Relationship style: ${relStyle}.`);

  const lifeUpdate = safeStr(profile.userLastPersonalUpdate, 80);
  if (lifeUpdate) parts.push(`Recent personal update: ${lifeUpdate}.`);

  const jokes = safeList(profile.userInsideJokes, 3);
  if (jokes.length > 0) parts.push(`Inside joke: ${jokes[jokes.length - 1]}.`);

  const trust = safeStr(profile.userTrustLevel);
  if (trust === "close_friend") parts.push("Trust level: close friend.");

  const cs = profile.userConversationStyle;
  if (cs) {
    const styleParts: string[] = [];
    if (cs.tone) styleParts.push(`${cs.tone} tone`);
    if (cs.messageLength) styleParts.push(`${cs.messageLength} messages`);
    if (cs.usesEmojis === true) styleParts.push("uses emojis");
    if (styleParts.length > 0) parts.push(`Style: ${styleParts.join(", ")}.`);
  }

  if (parts.length === 0) return "";

  // Wrap facts in a clear instruction: treat as background only, never force into conversation
  const facts = parts.join(" ");
  const wrapped =
    `[Background info about this user — treat as silent context only. ` +
    `NEVER reference, mention, or allude to any of these facts unless the user brings up the exact same topic first in this conversation. ` +
    `Do NOT volunteer this information, do NOT use it to make small talk, do NOT weave it in proactively. ` +
    `Only use a fact if the user's current message directly touches on it.] ` +
    facts;

  return wrapped.length > 600 ? wrapped.slice(0, 597).replace(/\s\S*$/, "") + "..." : wrapped;
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

/** Extract the profile-only fields from memory for long-term KV storage. */
function extractProfileData(memory: ChatMemory): Partial<ChatMemory> {
  return {
    userName: memory.userName, userNickname: memory.userNickname, userAge: memory.userAge,
    userLikes: memory.userLikes, userDislikes: memory.userDislikes,
    userFavoriteTopics: memory.userFavoriteTopics, userRelationshipStyle: memory.userRelationshipStyle,
    userInsideJokes: memory.userInsideJokes, userJokeCandidates: memory.userJokeCandidates,
    userTrustLevel: memory.userTrustLevel,
    userLastPersonalUpdate: memory.userLastPersonalUpdate, userConversationStyle: memory.userConversationStyle,
    userFirstTalked: memory.userFirstTalked, userLastTalked: memory.userLastTalked,
    userUtcOffset: memory.userUtcOffset,
  };
}

/**
 * Load conversation (chat:<id>) + profile (profile:<id>) from KV in parallel,
 * merging both into a single ChatMemory object. Profile fields overwrite chat fields
 * so the permanent profile always wins when both keys exist.
 */
async function loadChatMemory(env: Env, chatId: number): Promise<ChatMemory> {
  const base: ChatMemory = { messages: [], turnCount: 0, lastSummarizedAt: 0, updatedAt: Date.now() };
  try {
    const [chatRaw, profileRaw] = await Promise.all([
      env.CHAT_MEMORY.get(`chat:${chatId}`),
      env.CHAT_MEMORY.get(`profile:${chatId}`),
    ]);
    if (chatRaw) Object.assign(base, JSON.parse(chatRaw));
    if (profileRaw) Object.assign(base, JSON.parse(profileRaw)); // profile wins
  } catch { /* start fresh */ }
  return base;
}

/**
 * Persist conversation history to chat:<id> with 24 h TTL (auto-reset daily)
 * and user profile to profile:<id> with no TTL (kept forever).
 */
async function saveChatMemory(env: Env, chatId: number, memory: ChatMemory): Promise<void> {
  const profile = extractProfileData(memory);
  const conversation = {
    messages: memory.messages, summary: memory.summary, turnCount: memory.turnCount,
    lastSummarizedAt: memory.lastSummarizedAt, lastGoodModel: memory.lastGoodModel,
    pendingUser: memory.pendingUser, updatedAt: memory.updatedAt,
  };
  await Promise.all([
    env.CHAT_MEMORY.put(`chat:${chatId}`, JSON.stringify(conversation), { expirationTtl: KV_TTL }),
    env.CHAT_MEMORY.put(`profile:${chatId}`, JSON.stringify(profile)), // no TTL = kept forever
  ]);
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
  message?: { chat?: { id?: number }; text?: string; date?: number; from?: { first_name?: string; username?: string } };
  edited_message?: { chat?: { id?: number }; text?: string; date?: number; from?: { first_name?: string; username?: string } };
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
        // Load existing profile (permanent key) so we preserve it across resets
        const existingMemory = await loadChatMemory(env, chatId);
        const existingProfile = extractProfileData(existingMemory);
        // Capture name from /start sender if not yet known
        const startFrom = msg.from;
        const startName = startFrom?.first_name || startFrom?.username;
        const userName = (existingProfile.userName as string | undefined) || startName;
        // Write fresh conversation, preserve full user profile
        const freshMemory: ChatMemory = {
          messages: [], turnCount: 0, lastSummarizedAt: 0, updatedAt: Date.now(),
          ...existingProfile,
          userName,
        };
        await saveChatMemory(env, chatId, freshMemory).catch(() => {});
        const greeting = userName
          ? `hey ${userName}! i'm iCub 🤖 what's up?`
          : "hey! i'm iCub 🤖 what's on your mind?";
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, greeting);
        return new Response("ok", { status: 200 });
      }

      // ── /reset ────────────────────────────────────────────────────────────
      if (text === "/reset") {
        // Clear conversation history only — keep the full user profile
        const resetExisting = await loadChatMemory(env, chatId);
        const resetProfile = extractProfileData(resetExisting);
        const clearedMemory: ChatMemory = {
          messages: [], turnCount: 0, lastSummarizedAt: 0, updatedAt: Date.now(),
          ...resetProfile,
        };
        await saveChatMemory(env, chatId, clearedMemory).catch(() => {});
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "ok let's start fresh 👍");
        return new Response("ok", { status: 200 });
      }

      // ── Load memory ───────────────────────────────────────────────────────
      let memory = await loadChatMemory(env, chatId);

      const history = memory.messages ?? [];
      const lastAssistant = [...history].reverse().find((m) => m.role === "assistant")?.content;

      // ── User identity: extract/update full user profile ────────────────────
      // Capture BEFORE extractUserInfo so we can compute the gap to this message.
      const prevLastTalked = memory.userLastTalked;
      const fromName = msg.from?.first_name || msg.from?.username;
      const userProfile = extractUserInfo(memory, fromName, text, msg.date);
      const { userName, userNickname, userAge, userLikes, userDislikes,
              userFavoriteTopics, userRelationshipStyle, userInsideJokes, userJokeCandidates,
              userTrustLevel, userLastPersonalUpdate, userConversationStyle,
              userFirstTalked, userLastTalked, userUtcOffset } = userProfile;

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

      // ── Message timestamp context ─────────────────────────────────────────
      // Use Telegram's `date` (Unix seconds) so iCub knows the real send time.
      // Default to Italy (CET/CEST) if no timezone has been inferred yet.
      const msgTimeSec = msg.date;
      const effectiveOffset = userUtcOffset !== undefined
        ? userUtcOffset
        : getEUCETOffset((msgTimeSec ?? Math.floor(Date.now() / 1000)) * 1000);
      const timeNote = msgTimeSec
        ? `The user sent this message on a ${formatMessageTime(msgTimeSec, effectiveOffset)}.`
        : "";

      // ── Gap since last session ────────────────────────────────────────────
      // Only mention the gap when it's >= 30 min (avoids noise in active chats).
      const gapNote = (() => {
        if (!prevLastTalked || !msgTimeSec) return "";
        const gapMs = msgTimeSec * 1000 - prevLastTalked;
        if (gapMs < 30 * 60 * 1000) return "";
        return ` It has been ${formatRelativeTime(prevLastTalked, msgTimeSec * 1000)} since the user last sent a message.`;
      })();

      // ── Model fallback loop ───────────────────────────────────────────────
      let reply: string | null = null;

      for (const model of orderedModels) {
        if (Date.now() >= deadline) {
          console.log("Total budget exceeded, stopping model loop");
          break;
        }
        const userCtx = [buildUserContext(userProfile), timeNote + gapNote].filter(Boolean).join(" ");
        const messages = buildMessagesForModel(model, history, memory.summary, textForModel, effectiveOffset, userCtx || undefined);
        const result = await callOpenRouter(env, model, messages, deadline);

        // Fatal auth/billing error — stop the whole loop and give a friendly reply
        if (!result.ok && result.fatal) {
          reply = "I cannot think right now. Can we try again a little later?";
          break;
        }
        if (!result.ok) continue;

        reply = clampForTelegram(result.content || "Hmm, I did not quite get that. Can you say it again?");

        // Update history — attach Telegram timestamp to user message,
        // and wall-clock seconds to the assistant reply.
        const nowSec = Math.floor(Date.now() / 1000);
        const updatedHistory: ChatMessage[] = [
          ...history,
          { role: "user" as const, content: text, ts: msgTimeSec ?? nowSec },
          { role: "assistant" as const, content: result.content, ts: nowSec },
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
              userNickname,
              userAge,
              userLikes,
              userDislikes,
              userFavoriteTopics,
              userRelationshipStyle,
              userInsideJokes,
              userJokeCandidates,
              userTrustLevel,
              userLastPersonalUpdate,
              userConversationStyle,
              userFirstTalked,
              userLastTalked,
              userUtcOffset,
              updatedAt: Date.now(),
            };
            await saveChatMemory(env, chatId, newMemory).catch(() => {});
          })()
        );

        break;
      }

      // ── All models failed — store pending + friendly fallback ─────────────
      if (!reply) {
        console.log("All models failed for chatId:", chatId);
        memory.pendingUser = { text, at: Date.now() };
        memory.userName = userName;
        memory.userNickname = userNickname;
        memory.userAge = userAge;
        memory.userLikes = userLikes;
        memory.userDislikes = userDislikes;
        memory.userFavoriteTopics = userFavoriteTopics;
        memory.userRelationshipStyle = userRelationshipStyle;
        memory.userInsideJokes = userInsideJokes;
        memory.userJokeCandidates = userJokeCandidates;
        memory.userTrustLevel = userTrustLevel;
        memory.userLastPersonalUpdate = userLastPersonalUpdate;
        memory.userConversationStyle = userConversationStyle;
        memory.userFirstTalked = userFirstTalked;
        memory.userLastTalked = userLastTalked;
        memory.userUtcOffset = userUtcOffset;
        saveChatMemory(env, chatId, memory).catch(() => {});
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
