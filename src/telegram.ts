import type { Config } from "./config";
import { getMessages, isLang } from "./i18n";
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

/**
 * Short sanitized alert about a failed background run — no error text, details stay in
 * the Workers logs. Takes env only: it must work even if config parsing is what broke.
 */
export async function notifyTelegramError(env: Env): Promise<void> {
  const lang = isLang(env.REPORT_LANG ?? "") ? env.REPORT_LANG : "en";
  const res = await send(env, getMessages(lang).telegram.failed);
  if (!res.ok) {
    throw new Error(`Telegram sendMessage (error alert) -> ${res.status}: ${await res.text()}`);
  }
}

export async function notifyTelegram(
  env: Env,
  config: Config,
  llmMessage: string,
  achievements: UnlockedAchievement[],
  reportUrl: string,
): Promise<void> {
  const m = config.messages.telegram;
  const parts = [llmMessage];
  if (achievements.length > 0) {
    parts.push(m.newAchievements(achievements.map((a) => `<b>${a.title}</b>`).join(", ")));
  }
  parts.push(`<a href="${reportUrl}">${m.openReport}</a>`);
  const html = parts.join("\n\n");

  const res = await send(env, html, "HTML");
  if (res.ok) return;

  // The LLM may have produced invalid HTML — retry without markup so the message lands
  const stripped = html.replace(/<[^>]+>/g, "");
  const fallback = await send(env, `${stripped}\n\n${reportUrl}`);
  if (!fallback.ok) {
    throw new Error(`Telegram sendMessage -> ${fallback.status}: ${await fallback.text()}`);
  }
}
