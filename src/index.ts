import { runWeekly } from "./run";

async function keyMatches(provided: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async scheduled(_event, env, _ctx) {
    const result = await runWeekly(env, new Date());
    console.log(JSON.stringify({ event: "weekly_report_done", ...result }));
  },

  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.pathname !== "/run") {
      return new Response("Not found", { status: 404 });
    }
    const key = url.searchParams.get("key") ?? "";
    if (!env.RUN_SECRET || !(await keyMatches(key, env.RUN_SECRET))) {
      return new Response("Forbidden", { status: 403 });
    }

    // ?date=YYYY-MM-DD — прогон за неделю, оканчивающуюся этой датой (для тестов)
    const dateParam = url.searchParams.get("date");
    const until = dateParam ? new Date(`${dateParam}T09:00:00+02:00`) : new Date();
    if (Number.isNaN(until.getTime())) {
      return new Response("Bad date", { status: 400 });
    }

    try {
      const result = await runWeekly(env, until);
      return Response.json(result);
    } catch (err) {
      console.log(JSON.stringify({ event: "run_failed", error: String(err) }));
      return Response.json({ error: String(err) }, { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;
