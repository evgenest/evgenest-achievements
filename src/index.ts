import { loadConfig } from "./config";
import { runWeekly } from "./run";
import { notifyTelegramError } from "./telegram";
import { zonedTimeToUtc } from "./time";

async function keyMatches(provided: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// The full error goes to the Workers logs only (private, requires Cloudflare account access).
// Telegram gets a short sanitized notice without the error text: either way the week's
// outcome reaches the bot — either the finished report or the fact that it failed.
async function runInBackground(env: Env, until: Date): Promise<void> {
  try {
    const result = await runWeekly(env, until);
    console.log(JSON.stringify({ event: "run_done", ...result }));
  } catch (err) {
    console.error(JSON.stringify({ event: "run_failed", error: String(err) }));
    try {
      await notifyTelegramError(env);
    } catch (notifyErr) {
      console.error(JSON.stringify({ event: "telegram_error_notify_failed", error: String(notifyErr) }));
    }
  }
}

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runInBackground(env, new Date()));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }
    const auth = request.headers.get("Authorization") ?? "";
    const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    if (!env.RUN_SECRET || !(await keyMatches(key, env.RUN_SECRET))) {
      return new Response("Forbidden", { status: 403 });
    }

    // ?date=YYYY-MM-DD — run for the week ending on that date (for testing).
    // Interpreted as 09:00 local time in the configured TIMEZONE, DST included.
    const dateParam = url.searchParams.get("date");
    const until = dateParam ? zonedTimeToUtc(dateParam, "09:00:00", loadConfig(env).timezone) : new Date();
    if (Number.isNaN(until.getTime())) {
      return new Response("Bad date", { status: 400 });
    }

    ctx.waitUntil(runInBackground(env, until));
    return Response.json({ status: "accepted" }, { status: 202 });
  },
} satisfies ExportedHandler<Env>;
