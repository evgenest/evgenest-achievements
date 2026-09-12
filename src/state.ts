import type { AppState, MarketRates, WeekActivity } from "./types";

/**
 * State is append-only: every run writes a new snapshot under `state:<ISO timestamp>`,
 * and the lexicographically last key (= chronologically newest) is the live state.
 * A manual test run can therefore be undone by deleting just that key — the previous
 * snapshot becomes current again and the next report is built on top of it.
 */
const PREFIX = "state:";
/** Pre-versioning single key. Read only while no versioned snapshot exists. */
const LEGACY_KEY = "state";
/** Snapshots kept in KV (~a year of weekly runs); older ones are pruned after each save. */
const HISTORY_LIMIT = 52;

const EMPTY_STATE: AppState = {
  reportCount: 0,
  streak: 0,
  bestStreak: 0,
  allTime: { commits: 0, prs: 0, issues: 0, additions: 0, deletions: 0, activeWeeks: 0 },
  unlocked: [],
  lastWeek: null,
  lastRunUntil: null,
  rates: null,
};

/** Stored alongside the snapshot so the history can be listed without reading every value. */
export interface StateMeta {
  savedAt: string; // ISO — when the snapshot was written
  until: string | null; // ISO — end of the period the snapshot covers
  reportCount: number;
  streak: number;
}

export interface StateVersion {
  key: string;
  meta: StateMeta | null;
}

/** All snapshots, oldest first — KV lists keys in lexicographic order. */
export async function listStateVersions(env: Env): Promise<StateVersion[]> {
  const versions: StateVersion[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.STATE.list<StateMeta>({ prefix: PREFIX, cursor });
    for (const key of page.keys) versions.push({ key: key.name, meta: key.metadata ?? null });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return versions;
}

/** Newest snapshot; falls back to older ones and then to the pre-versioning key. */
export async function loadState(env: Env): Promise<AppState> {
  const versions = await listStateVersions(env);
  for (let i = versions.length - 1; i >= 0; i--) {
    const raw = await env.STATE.get<AppState>(versions[i].key, "json");
    if (raw) return raw;
  }
  const legacy = await env.STATE.get<AppState>(LEGACY_KEY, "json");
  return legacy ?? structuredClone(EMPTY_STATE);
}

export function isActiveWeek(week: WeekActivity): boolean {
  return week.totalCommits > 0 || week.prs.length > 0 || week.issues.length > 0;
}

/**
 * Next state after a week: streak, totals, snapshot. Does not mutate the input.
 * Cached market rates are carried forward unless fresher ones are passed in.
 */
export function advanceState(
  state: AppState,
  week: WeekActivity,
  newlyUnlocked: string[],
  rates: MarketRates | null = state.rates ?? null,
): AppState {
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
    rates,
  };
}

/** Appends a snapshot, prunes the oldest beyond the limit, returns the new key. */
export async function saveState(env: Env, state: AppState, savedAt: Date = new Date()): Promise<string> {
  const iso = savedAt.toISOString();
  const key = `${PREFIX}${iso}`;
  const metadata: StateMeta = {
    savedAt: iso,
    until: state.lastRunUntil,
    reportCount: state.reportCount,
    streak: state.streak,
  };
  await env.STATE.put(key, JSON.stringify(state), { metadata });

  const versions = await listStateVersions(env);
  for (const stale of versions.slice(0, Math.max(0, versions.length - HISTORY_LIMIT))) {
    await env.STATE.delete(stale.key);
  }
  return key;
}

/** Drops the newest snapshot — the undo for a manual run. Returns the key or null. */
export async function deleteLatestState(env: Env): Promise<string | null> {
  const latest = (await listStateVersions(env)).at(-1);
  if (!latest) return null;
  await env.STATE.delete(latest.key);
  return latest.key;
}
