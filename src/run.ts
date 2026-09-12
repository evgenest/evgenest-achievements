import { detectAchievements } from "./achievements";
import { loadConfig } from "./config";
import { computeWeekCost } from "./cost";
import { collectWeekActivity, commitFile } from "./github";
import { buildCommitTimeline, resolveHours } from "./hours";
import { generateInsights } from "./llm";
import { applyPrivacy } from "./privacy";
import { resolveRates } from "./rates";
import { buildReport } from "./report";
import { advanceState, isActiveWeek, loadState, saveState } from "./state";
import { notifyTelegram } from "./telegram";

export interface RunResult {
  reportPath: string;
  reportUrl: string;
  commits: number;
  prs: number;
  issues: number;
  activeRepos: number;
  newAchievements: string[];
  /** KV key of the snapshot this run appended — delete it to undo the run. */
  stateKey: string;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOOKBACK_MS = 4 * WEEK_MS;

export async function runWeekly(env: Env, until: Date): Promise<RunResult> {
  const config = loadConfig(env);
  const state = await loadState(env);

  // Catch up on missed periods (failed cron, invalid LLM answer) starting from the last
  // successful run, but never more than 4 weeks back — beyond that GitHub API limits bite.
  const earliestSince = new Date(until.getTime() - MAX_LOOKBACK_MS);
  const lastRunUntil = state.lastRunUntil ? new Date(state.lastRunUntil) : null;
  const since = lastRunUntil
    ? new Date(Math.max(lastRunUntil.getTime(), earliestSince.getTime()))
    : new Date(until.getTime() - WEEK_MS);

  const collected = await collectWeekActivity(env, config, since, until);
  const week = applyPrivacy(collected, config.privacy);

  const newStreak = isActiveWeek(week) ? state.streak + 1 : 0;
  const achievements = detectAchievements(config, week, state, newStreak);
  const timeline = buildCommitTimeline(week);
  // Rates come from the state cache (a lookup only when stale) and never throw.
  const [llm, rates] = await Promise.all([
    generateInsights(env, config, week, state, newStreak, timeline),
    config.salaryEstimate ? resolveRates(env, config, state.rates) : Promise.resolve(state.rates ?? null),
  ]);
  const hours = resolveHours(timeline, llm.commitMinutes);
  console.log(
    JSON.stringify({
      event: "hours_estimate",
      commits: timeline.length,
      fromModel: hours.fromModel,
      fallback: hours.fallback,
      capped: hours.capped,
      hours: hours.hours,
    }),
  );

  const cost = config.salaryEstimate && rates ? computeWeekCost(hours.hours, rates) : null;

  const markdown = buildReport({ config, week, state, newStreak, achievements, llm, cost });
  const day = until.toISOString().slice(0, 10);
  const reportPath = `${config.reportsDir}/${day}.md`;
  const reportUrl = await commitFile(env, config, reportPath, markdown, `report: week of ${day}`);

  await notifyTelegram(env, config, llm.telegramMessage, achievements, reportUrl);
  const stateKey = await saveState(env, advanceState(state, week, achievements.map((a) => a.id), rates));

  return {
    stateKey,
    reportPath,
    reportUrl,
    commits: week.totalCommits,
    prs: week.prs.length,
    issues: week.issues.length,
    activeRepos: week.repos.length,
    newAchievements: achievements.map((a) => a.title),
  };
}
