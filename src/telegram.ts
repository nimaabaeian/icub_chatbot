/**
 * Telegram Bot API helpers.
 */

const TELEGRAM_MAX_CHARS = 450;

export async function sendTelegramMessage(token: string, chatId: number, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export function sendTypingAction(token: string, chatId: number): void {
  fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
}

export function clampForTelegram(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= TELEGRAM_MAX_CHARS) return trimmed;
  const suffix = "… What should we do next?";
  const keepLen = Math.max(30, TELEGRAM_MAX_CHARS - suffix.length);
  return `${trimmed.slice(0, keepLen).trimEnd()}${suffix}`;
}

export function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const ICUB_FALLBACKS = [
  "Oh no, my brain got a bit stuck! Can you say that again? I promise I am listening!",
  "Hmm, I think I got confused for a moment. Could you tell me just one short detail and we can try again?",
  "Oops, something went funny inside my head! Do you want to try asking me again? I am really curious!",
  "I got a little tangled up just now. Can you repeat that? Or pick something simple for us to talk about?",
  "Uh oh, I am not sure what happened! Can you ask me again? I want to answer you properly!",
];
