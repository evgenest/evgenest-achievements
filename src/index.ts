import { loadConfig } from "./config";
import { runWeekly } from "./run";
import { deleteLatestState, listStateVersions } from "./state";
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

async function authorized(request: Request, env: Env): Promise<boolean> {
  const auth = request.headers.get("Authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  return Boolean(env.RUN_SECRET) && (await keyMatches(key, env.RUN_SECRET));
}

interface RunMessage {
  until: string; // ISO
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

  // A batch always holds messages sent by /run below — one per manual (or ?date=) request.
  async queue(batch: MessageBatch<RunMessage>, env) {
    for (const message of batch.messages) {
      await runInBackground(env, new Date(message.body.until));
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    if (!["POST /run", "GET /run", "GET /state", "DELETE /state/latest"].includes(route)) {
      return new Response("Not found", { status: 404 });
    }
    if (!(await authorized(request, env))) {
      return new Response("Forbidden", { status: 403 });
    }

    // History of state snapshots, oldest first. The last entry is the live state —
    // the one a manual run has just appended.
    if (route === "GET /state") {
      const versions = await listStateVersions(env);
      return Response.json({ current: versions.at(-1)?.key ?? null, versions });
    }

    // Undo the newest run: the previous snapshot becomes current again, so the next
    // run rebuilds the week on top of it instead of double-counting.
    if (route === "DELETE /state/latest") {
      const deleted = await deleteLatestState(env);
      return deleted
        ? Response.json({ deleted })
        : Response.json({ error: "no state snapshots" }, { status: 404 });
    }

    // ?date=YYYY-MM-DD — run for the week ending on that date (for testing).
    // Interpreted as 09:00 local time in the configured TIMEZONE, DST included.
    const dateParam = url.searchParams.get("date");
    const until = dateParam ? zonedTimeToUtc(dateParam, "09:00:00", loadConfig(env).timezone) : new Date();
    if (Number.isNaN(until.getTime())) {
      return new Response("Bad date", { status: 400 });
    }

    // Handed off to RUN_QUEUE instead of ctx.waitUntil(): an HTTP-triggered invocation's
    // waitUntil is capped at 30s by Cloudflare, too short for GitHub collection + LLM + commit.
    // The queue consumer above gets the same 15-minute budget as the cron trigger.
    await env.RUN_QUEUE.send({ until: until.toISOString() } satisfies RunMessage);
    return Response.json({ status: "accepted" }, { status: 202 });
  },
} satisfies ExportedHandler<Env, RunMessage>;
