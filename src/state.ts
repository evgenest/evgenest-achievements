import type { AppState, WeekActivity } from "./types";

const KEY = "state";

const EMPTY_STATE: AppState = {
  reportCount: 0,
  streak: 0,
  bestStreak: 0,
  allTime: { commits: 0, prs: 0, issues: 0, additions: 0, deletions: 0, activeWeeks: 0 },
  unlocked: [],
  lastWeek: null,
  lastRunUntil: null,
};

export async function loadState(env: Env): Promise<AppState> {
  const raw = await env.STATE.get<AppState>(KEY, "json");
  return raw ?? structuredClone(EMPTY_STATE);
}

export function isActiveWeek(week: WeekActivity): boolean {
  return week.totalCommits > 0 || week.prs.length > 0 || week.issues.length > 0;
}

/** Next state after a week: streak, totals, snapshot. Does not mutate the input. */
export function advanceState(state: AppState, week: WeekActivity, newlyUnlocked: string[]): AppState {
  const active = isActiveWeek(week);
  const streak = active ? state.streak + 1 : 0;
  return {
    reportCount: state.reportCount + 1,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    allTime: {
      commits: state.allTime.commits + week.totalCommits,
      prs: state.allTime.prs + week.prs.length,
      issues: state.allTime.issues + week.issues.length,
      additions: state.allTime.additions + week.totalAdditions,
      deletions: state.allTime.deletions + week.totalDeletions,
      activeWeeks: state.allTime.activeWeeks + (active ? 1 : 0),
    },
    unlocked: [...state.unlocked, ...newlyUnlocked],
    lastWeek: {
      commits: week.totalCommits,
      prs: week.prs.length,
      issues: week.issues.length,
      additions: week.totalAdditions,
      deletions: week.totalDeletions,
    },
    lastRunUntil: week.until,
  };
}

export async function saveState(env: Env, state: AppState): Promise<void> {
  await env.STATE.put(KEY, JSON.stringify(state));
}
