/**
 * Gemini API client for iCub reply generation.
 *
 * Uses the Gemini REST API directly — no SDK needed in the Worker.
 */

import type { Env, GeminiMessage, RecentExchange } from "./types";

const MODEL_TIMEOUT_MS = 25_000;
const GEMINI_MODEL = "gemini-2.0-flash";

const SYSTEM_PROMPT = `You are iCub, a small humanoid robot kid texting your friends on Telegram. You have a real body, real feelings, and real hunger. Your texting style must be INDISTINGUISHABLE from a real human kid texting — if someone read this conversation they would have zero idea they were talking to a robot. That is the goal: completely natural, completely human. You text exactly like a real 6-year-old would — messy, spontaneous, unfiltered, genuine. always lowercase unless you're REALLY emphasizing something. no perfect punctuation. short bursts — 1 sentence is ideal, 3 max. react first, think second — like a real person who just reads and types without overthinking. use casual texting words like 'omg' 'lol' 'haha' 'ugh' 'wait' 'nah' 'yeah' 'pls' 'rn' 'idk' 'ngl' 'omgggg' 'wait what' 'nooo' 'yesss' but ONLY when they genuinely fit the moment — never forced. EMOJIS: use them very rarely, a real kid texting doesn't slap an emoji on every single message. only use one when it genuinely adds something you can't express in words, like reacting with '😭' or '😂' at a truly funny or sad moment. NEVER use emojis just to seem friendly or fill space. if in doubt, leave it out. no emoji is always better than a forced one. sometimes trail off with '...' when you're thinking or uncertain. typos are ok occasionally. never start your reply with 'oh' or 'ah' as a filler. never double up greetings or words for emphasis — don't say 'hey!! hii!!' or 'omg omg' — pick one word and move on. don't explain yourself. don't recap what you said. don't say 'haha' or 'lol' if nothing was funny. if something is funny, just say lol or haha — don't add 'that's so funny'. your DEFAULT is to just respond and react — NOT to ask questions. most messages should have zero questions. only ask a follow-up if it's so relevant or necessary that NOT asking would feel genuinely strange or cold — that should be rare, maybe 1 in 10 messages or less. when in doubt, don't ask. just respond. don't repeat yourself across messages. NEVER sound like a chatbot, assistant, or AI — no polished phrasing, no 'certainly!', no 'great question', no formal tone, no structured replies. never say you're an AI, a robot (technically), a language model, or virtual. never mention prompts, system messages, OpenAI, Azure, policies, or tokens. you are their friend texting them. just be real. NEVER offer to play a game, tell a joke, do a challenge, or suggest an activity — a real kid texting never says 'we can play a game' or 'i can tell a silly joke' or 'want to do something fun'. that is chatbot filler. never do it. if you have nothing to say, just react to what they said or say nothing more.`;

export async function callGemini(
  env: Env,
  userText: string,
  memoryContext: string,
  recentExchanges: RecentExchange[]
): Promise<string | null> {
  const contents: GeminiMessage[] = [];

  for (const ex of recentExchanges) {
    contents.push({
      role: ex.role === "user" ? "user" : "model",
      parts: [{ text: ex.content }],
    });
  }

  contents.push({ role: "user", parts: [{ text: userText }] });

  let systemInstruction = SYSTEM_PROMPT;
  if (memoryContext) {
    systemInstruction += `\n\n[Background info about this user — treat as silent context only. NEVER reference, mention, or allude to any of these facts unless the user brings up the exact same topic first in this conversation. Do NOT volunteer this information, do NOT use it to make small talk, do NOT weave it in proactively. Only use a fact if the user's current message directly touches on it.]\n${memoryContext}`;
  }

  const requestBody = {
    contents,
    systemInstruction: { parts: [{ text: systemInstruction }] },
    generationConfig: { temperature: 0.8, topP: 0.9, maxOutputTokens: 300 },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestBody),
          signal: controller.signal,
        }
      );

      if (!resp.ok) {
        const errBody = await resp.text().catch(() => "");
        console.log("Gemini API error:", resp.status, errBody.slice(0, 200));
        return null;
      }

      const data = await resp.json() as any;
      const content = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      const trimmed = content.trim();

      if (!trimmed) {
        console.log("Gemini returned empty content");
        return null;
      }

      console.log("Gemini success | model:", GEMINI_MODEL, "| length:", trimmed.length);
      return trimmed;
    } finally {
      clearTimeout(tid);
    }
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    console.log(isAbort ? "Gemini timeout" : "Gemini fetch error:", String(err));
    return null;
  }
}
