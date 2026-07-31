import type { UnlockedAchievement } from "./types";

async function send(env: Env, text: string, parseMode?: "HTML"): Promise<Response> {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }),
  });
}

export async function notifyTelegram(
  env: Env,
  llmMessage: string,
  achievements: UnlockedAchievement[],
  reportUrl: string,
): Promise<void> {
  const parts = [llmMessage];
  if (achievements.length > 0) {
    parts.push(`Новые ачивки: ${achievements.map((a) => `<b>${a.title}</b>`).join(", ")}`);
  }
  parts.push(`<a href="${reportUrl}">Открыть полный отчёт</a>`);
  const html = parts.join("\n\n");

  const res = await send(env, html, "HTML");
  if (res.ok) return;

  // LLM мог сгенерировать невалидный HTML — повторяем без разметки, чтобы уведомление дошло
  const stripped = html.replace(/<[^>]+>/g, "");
  const fallback = await send(env, `${stripped}\n\n${reportUrl}`);
  if (!fallback.ok) {
    throw new Error(`Telegram sendMessage -> ${fallback.status}: ${await fallback.text()}`);
  }
}
