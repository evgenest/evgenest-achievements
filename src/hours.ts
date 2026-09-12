import type { CommitEstimate, CommitInfo, WeekActivity } from "./types";

/**
 * Focused-hours estimate: the model judges each commit, the clock bounds it.
 *
 * All (non-merge) commits of the week, across every repository, are put on ONE timeline
 * — the developer's time is shared between projects. Each commit gets a window: the
 * minutes that actually passed since the previous commit. The model estimates how many
 * of those minutes the change really took; code clamps that estimate into the window,
 * sums it up and applies a weekly ceiling. The window is an upper bound, not the answer:
 * a one-line fix two hours after the last commit is still a few minutes of work.
 *
 * Tuning knobs, all in one place:
 */

/** A pause longer than this ends a work session; the next commit starts a new one. */
export const SESSION_GAP_MINUTES = 180;
/** Window of the first commit of a session (or of the week): the time before it is unknown, so it is assumed. */
export const SESSION_START_MINUTES = 120;
/** No single commit may claim more than this, whatever the gap (belt and braces for the knobs above). */
export const MAX_WINDOW_MINUTES = 150;
/** Floor for a commit's estimate — even a typo fix takes a few minutes. Never above the window. */
export const MIN_COMMIT_MINUTES = 5;
/** Ceiling on the weekly total, so a noisy week can't claim more than a heavy working week. */
export const WEEKLY_HOURS_CAP = 60;

export interface TimelineCommit {
  /** Stable id = position on the timeline; the LLM answers by it. */
  id: number;
  /** Display name of the repository (a placeholder for redacted ones). */
  repo: string;
  redacted: boolean;
  commit: CommitInfo;
  /** Upper bound for this commit's work, in whole minutes (≥ 1). */
  windowMinutes: number;
  /** True when the previous commit is missing or older than SESSION_GAP_MINUTES. */
  startsSession: boolean;
}

const MINUTE_MS = 60_000;

/** Author date first: rebases rewrite the committer date of every commit to the same instant. */
function workedAt(c: CommitInfo): number {
  const authored = c.authoredDate ? Date.parse(c.authoredDate) : Number.NaN;
  const t = Number.isNaN(authored) ? Date.parse(c.date) : authored;
  return Number.isNaN(t) ? 0 : t;
}

/** Every commit of the week on a single chronological timeline with its time window. */
export function buildCommitTimeline(week: WeekActivity): TimelineCommit[] {
  const entries = week.repos.flatMap((r, repoIndex) =>
    r.commits.map((commit, commitIndex) => ({ r, commit, at: workedAt(commit), repoIndex, commitIndex })),
  );
  // Ties are broken by input order so ids are deterministic for the same week.
  entries.sort((a, b) => a.at - b.at || a.repoIndex - b.repoIndex || a.commitIndex - b.commitIndex);

  let prevAt: number | null = null;
  return entries.map((e, id) => {
    const gap = prevAt === null ? Number.POSITIVE_INFINITY : (e.at - prevAt) / MINUTE_MS;
    prevAt = e.at;
    const startsSession = gap > SESSION_GAP_MINUTES;
    const raw = startsSession ? SESSION_START_MINUTES : gap;
    return {
      id,
      repo: e.r.displayName,
      redacted: e.r.redacted,
      commit: e.commit,
      windowMinutes: Math.max(1, Math.min(MAX_WINDOW_MINUTES, Math.ceil(raw))),
      startsSession,
    };
  });
}

/**
 * Deterministic stand-in when the model gave no usable estimate for a commit:
 * grows with the square root of the lines touched (10 lines ≈ 20 min, 100 ≈ 40, 1000 ≈ 105).
 */
export function heuristicMinutes(c: CommitInfo): number {
  return Math.round(10 + 3 * Math.sqrt(Math.max(0, c.additions) + Math.max(0, c.deletions)));
}

function clampToWindow(minutes: number, window: number): number {
  return Math.min(window, Math.max(Math.min(MIN_COMMIT_MINUTES, window), minutes));
}

export interface HoursResult {
  /** Weekly total in hours, capped at WEEKLY_HOURS_CAP, rounded to 0.1. */
  hours: number;
  /** Minutes per timeline entry, after clamping (index = id). */
  perCommit: number[];
  /** How many commits used the model's estimate vs the heuristic fallback. */
  fromModel: number;
  fallback: number;
  /** True when the weekly ceiling cut the total. */
  capped: boolean;
}

export function resolveHours(timeline: readonly TimelineCommit[], estimates: readonly CommitEstimate[] | undefined): HoursResult {
  const byId = new Map<number, number>();
  for (const e of estimates ?? []) {
    // First answer per id wins; unknown ids, negatives and non-numbers are ignored.
    if (Number.isInteger(e?.id) && Number.isFinite(e?.minutes) && e.minutes >= 0 && !byId.has(e.id)) {
      byId.set(e.id, e.minutes);
    }
  }

  let fromModel = 0;
  const perCommit = timeline.map((t) => {
    const estimate = byId.get(t.id);
    if (estimate !== undefined) fromModel++;
    return clampToWindow(estimate ?? heuristicMinutes(t.commit), t.windowMinutes);
  });

  const rawHours = perCommit.reduce((s, m) => s + m, 0) / 60;
  return {
    hours: Math.round(Math.min(rawHours, WEEKLY_HOURS_CAP) * 10) / 10,
    perCommit,
    fromModel,
    fallback: timeline.length - fromModel,
    capped: rawHours > WEEKLY_HOURS_CAP,
  };
}
