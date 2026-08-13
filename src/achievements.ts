import type { Config } from "./config";
import { hourInZone } from "./time";
import type { AchievementDef, AppState, UnlockedAchievement, WeekActivity } from "./types";

/** Rules only — titles and descriptions come from the i18n bundle by id. */
function definitions(timeZone: string): AchievementDef[] {
  return [
    { id: "first-report", test: () => true },
    { id: "marathon", test: (w) => w.totalCommits >= 10 },
    { id: "sprinter", test: (w) => w.totalCommits >= 25 },
    { id: "shipper", test: (w) => w.prs.some((p) => p.state === "merged") },
    { id: "polyglot", test: (w) => new Set(w.repos.map((r) => r.language).filter(Boolean)).size >= 3 },
    { id: "night-owl", test: (w) => w.repos.some((r) => r.commits.some((c) => hourInZone(c.date, timeZone) < 6)) },
    { id: "multitasker", test: (w) => w.repos.length >= 3 },
    { id: "kilo-week", test: (w) => w.totalAdditions >= 1000 },
    { id: "deployer", test: (w) => w.repos.reduce((s, r) => s + r.deployments, 0) >= 1 },
    {
      id: "green-week",
      test: (w) => {
        const ok = w.repos.reduce((s, r) => s + r.ciSuccess, 0);
        const fail = w.repos.reduce((s, r) => s + r.ciFailure, 0);
        return ok >= 5 && fail === 0;
      },
    },
    { id: "streak-4", test: (_w, streak) => streak >= 4 },
    { id: "streak-8", test: (_w, streak) => streak >= 8 },
    { id: "streak-12", test: (_w, streak) => streak >= 12 },
    { id: "century", test: (w, _s, allTimeCommits) => allTimeCommits + w.totalCommits >= 100 },
  ];
}

export function detectAchievements(
  config: Config,
  week: WeekActivity,
  state: AppState,
  newStreak: number,
): UnlockedAchievement[] {
  return definitions(config.timezone)
    .filter((d) => !state.unlocked.includes(d.id) && d.test(week, newStreak, state.allTime.commits))
    .map((d) => ({ id: d.id, ...config.messages.achievements[d.id] }));
}
