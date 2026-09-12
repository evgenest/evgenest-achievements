import { buildCommitTimeline, type TimelineCommit } from "./hours";
import type { AppState, WeekActivity } from "./types";

/**
 * Data guard: the ONLY place where an LLM payload is assembled.
 *
 * Guarantees:
 * 1. The payload is an explicit projection — only the primitives listed below
 *    (commit headlines, PR/issue titles, counters, period dates, minutes between
 *    commits, languages). Source code, diffs, patches, file contents, URLs and commit
 *    timestamps cannot reach it by construction.
 * 2. assertSanitized() walks the finished payload and throws on any key outside
 *    the allowlist (fail-closed): if someone extends the activity types, the LLM
 *    call breaks instead of silently leaking new fields.
 * 3. Repositories redacted by the privacy policy (see privacy.ts) contribute
 *    counters and per-commit timing only — their names, commit messages and titles
 *    never get here.
 */

const MAX_TEXT = 200;

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

export interface LlmPayload {
  week: {
    since: string;
    until: string;
    repos: {
      repo: string;
      language: string | null;
      commitCount: number;
      additions: number;
      deletions: number;
      ciSuccess: number;
      ciFailure: number;
      deployments: number;
    }[];
    /** Every commit of the week, all repos, chronological — the basis of the hours estimate. */
    commits: {
      id: number;
      repo: string;
      message: string;
      additions: number;
      deletions: number;
      windowMinutes: number;
      startsSession: boolean;
    }[];
    prs: { repo: string; title: string; state: string }[];
    issues: { repo: string; title: string; state: string }[];
    totalCommits: number;
    totalAdditions: number;
    totalDeletions: number;
  };
  context: {
    weekNumber: number;
    streakWeeks: number;
    bestStreak: number;
    allTime: {
      commits: number;
      prs: number;
      issues: number;
      additions: number;
      deletions: number;
      activeWeeks: number;
    };
    lastWeek: {
      commits: number;
      prs: number;
      issues: number;
      additions: number;
      deletions: number;
    } | null;
  };
}

const ALLOWED_KEYS = new Set([
  "week", "context",
  "since", "until", "repos", "prs", "issues",
  "totalCommits", "totalAdditions", "totalDeletions",
  "repo", "language", "commitCount", "additions", "deletions",
  "ciSuccess", "ciFailure", "deployments",
  "title", "state",
  "weekNumber", "streakWeeks", "bestStreak", "allTime", "lastWeek",
  "commits", "activeWeeks",
  "id", "message", "windowMinutes", "startsSession",
]);

export function assertSanitized(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSanitized(v, `${path}[${i}]`));
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`LLM payload guard: unexpected key "${key}" at ${path} — the LLM call was blocked`);
    }
    assertSanitized(v, `${path}.${key}`);
  }
}

function commitEntry(t: TimelineCommit): LlmPayload["week"]["commits"][number] {
  const c = t.commit;
  return {
    id: t.id,
    repo: t.repo,
    // Redacted repos: timing and line counters only, no text.
    message: t.redacted ? "" : clip(c.message),
    additions: c.additions,
    deletions: c.deletions,
    windowMinutes: t.windowMinutes,
    startsSession: t.startsSession,
  };
}

export function buildLlmPayload(
  week: WeekActivity,
  state: AppState,
  newStreak: number,
  timeline: readonly TimelineCommit[] = buildCommitTimeline(week),
): LlmPayload {
  const payload: LlmPayload = {
    week: {
      since: week.since,
      until: week.until,
      repos: week.repos.map((r) => ({
        repo: r.displayName,
        language: r.language,
        commitCount: r.commits.length,
        additions: r.additions,
        deletions: r.deletions,
        ciSuccess: r.ciSuccess,
        ciFailure: r.ciFailure,
        deployments: r.deployments,
      })),
      commits: timeline.map(commitEntry),
      prs: week.prs.filter((p) => !p.redacted).map((p) => ({ repo: p.repo, title: clip(p.title), state: p.state })),
      issues: week.issues.filter((i) => !i.redacted).map((i) => ({ repo: i.repo, title: clip(i.title), state: i.state })),
      totalCommits: week.totalCommits,
      totalAdditions: week.totalAdditions,
      totalDeletions: week.totalDeletions,
    },
    context: {
      weekNumber: state.reportCount + 1,
      streakWeeks: newStreak,
      bestStreak: state.bestStreak,
      allTime: { ...state.allTime },
      lastWeek: state.lastWeek ? { ...state.lastWeek } : null,
    },
  };
  assertSanitized(payload);
  return payload;
}
