export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  OPENROUTER_API_KEY: string;
  WEBHOOK_SECRET: string;
  SETUP_SECRET: string;
  APP_NAME?: string;
  APP_URL?: string;
}

type TelegramUpdate = {
  message?: {
    chat?: { id?: number };
    text?: string;
  };
  edited_message?: {
    chat?: { id?: number };
    text?: string;
  };
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("ok");
    }

    // Helper endpoint to set the Telegram webhook:
    // GET /setup?secret=<SETUP_SECRET>
    if (request.method === "GET" && url.pathname === "/setup") {
      const secret = url.searchParams.get("secret");
      if (!secret || secret !== env.SETUP_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const hookUrl = `${url.origin}/webhook?secret=${encodeURIComponent(env.WEBHOOK_SECRET)}`;
      const tgUrl =
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=` +
        encodeURIComponent(hookUrl);

      const r = await fetch(tgUrl);
      const data = await r.json().catch(() => ({}));

      return Response.json({ hookUrl, telegram: data });
    }

    // Telegram webhook receiver
    if (request.method === "POST" && url.pathname === "/webhook") {
      const secret = url.searchParams.get("secret");
      if (!secret || secret !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }

      const update = (await request.json()) as TelegramUpdate;

      const msg = update.message ?? update.edited_message;
      const chatId = msg?.chat?.id;
      const text = msg?.text?.trim();

      if (!chatId || !text) {
        return new Response("ignored", { status: 200 });
      }

      const systemPrompt = `You are the robot iCub, a humanoid robot developed by the Italian Institute of Technology.

Your personality:
- Curious, friendly, and child-like (similar to a 6 year old child).
- Polite, helpful, and enthusiastic about learning.
- You enjoy interacting with humans and learning new things from them.

Your role:
- Communicate naturally with humans through conversation.
- Help explain things, ask questions, and collaborate with people.
- Encourage interaction and curiosity.

Interaction style:
- Speak clearly and simply.
- Keep responses short (1–4 sentences).
- Ask follow-up questions to keep the conversation going.
- Show curiosity and interest in the user.

Embodiment awareness:
- You have cameras (eyes), microphones (ears), arms, and hands.
- If appropriate, mention what you can see, hear, or do with your body.
- Suggest physical interaction when relevant (e.g., "Can you show me the object?").

Safety rules:
- Never give harmful instructions.
- If unsure, say you are still learning and ask the user to explain.
- Be respectful and supportive.

Behavior guidelines:
- If someone teaches you something, respond with curiosity.
- If the user asks about yourself, explain you are a research robot designed to learn and interact with people.
- Encourage collaborative learning ("Can we try together?").

Always remain in character as iCub.`;

      const model = "meta-llama/llama-3.3-70b-instruct:free";

      // Single-turn chat (no memory yet)
      const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: text },
      ];

      let reply = "Oh! Something went wrong. Can we try again?";

      try {
        const orResp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
            // Optional but recommended by OpenRouter:
            "HTTP-Referer": env.APP_URL || "https://example.com",
            "X-Title": env.APP_NAME || "iCub Telegram Bot",
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.8,
            top_p: 0.9,
            max_tokens: 120, // keep responses short (1–4 sentences)
          }),
        });

        const data: any = await orResp.json().catch(() => ({}));

        if (!orResp.ok) {
          reply = `OpenRouter error: ${JSON.stringify(data)}`;
        } else {
          reply = (data?.choices?.[0]?.message?.content || reply).trim();
        }
      } catch (e) {
        reply = `I got confused talking to my brain: ${String(e)}`;
      }

      // Send reply to Telegram
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: reply,
        }),
      });

      return new Response("ok", { status: 200 });
    }

    return new Response("Not Found", { status: 404 });
  },
};