import { detectAchievements } from "./achievements";
import { collectWeekActivity, commitFile } from "./github";
import { generateInsights } from "./llm";
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
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export async function runWeekly(env: Env, until: Date): Promise<RunResult> {
  const since = new Date(until.getTime() - WEEK_MS);

  const week = await collectWeekActivity(env, since, until);
  const state = await loadState(env);
  const newStreak = isActiveWeek(week) ? state.streak + 1 : 0;
  const achievements = detectAchievements(week, state, newStreak);
  const llm = await generateInsights(env, week, state, newStreak);

  const markdown = buildReport({ week, state, newStreak, achievements, llm });
  const day = until.toISOString().slice(0, 10);
  const reportPath = `reports/${day}.md`;
  const reportUrl = await commitFile(env, reportPath, markdown, `report: week of ${day}`);

  await notifyTelegram(env, llm.telegramMessage, achievements, reportUrl);
  await saveState(env, advanceState(state, week, achievements.map((a) => a.id)));

  return {
    reportPath,
    reportUrl,
    commits: week.totalCommits,
    prs: week.prs.length,
    issues: week.issues.length,
    activeRepos: week.repos.length,
    newAchievements: achievements.map((a) => a.title),
  };
}
