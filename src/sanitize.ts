import { buildCommitTimeline, type TimelineCommit } from "./hours";
import { assertNoSecrets, scrubSecrets } from "./secrets";
import type { AppState, WeekActivity } from "./types";

/**
 * Data guard: the ONLY place where an LLM payload is assembled.
 *
 * Guarantees:
 * 1. The payload is an explicit projection — only the primitives listed below
 *    (full commit messages, PR/issue titles and descriptions, counters, period dates,
 *    minutes between commits, languages). File contents, diffs, patches and URL fields
 *    are never fetched or projected, commit timestamps are never projected;
 *    human-written text may still quote code or links on its own.
 * 2. assertSanitized() walks the finished payload and throws on any key outside
 *    the allowlist (fail-closed): if someone extends the activity types, the LLM
 *    call breaks instead of silently leaking new fields.
 * 3. Every free-text field is secret-scrubbed and clipped (text()); assertNoSecrets()
 *    then re-scans every string of the finished payload and throws if anything
 *    secret-like is left (fail-closed, see secrets.ts).
 * 4. Repositories redacted by the privacy policy (see privacy.ts) contribute
 *    counters and per-commit timing only — their names, commit messages, titles and
 *    descriptions never get here.
 */

const MAX_TEXT = 1000;

function clip(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s;
}

/**
 * Free text on its way to the LLM. HTML comments go first (PR templates are full of them,
 * and they hide text from human readers); scrubbing runs on the whole text before
 * clipping, so a secret straddling the cut cannot leak half-way.
 */
function text(s: string): string {
  return clip(scrubSecrets(s.replace(/<!--[\s\S]*?-->/g, "").trim()));
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
    prs: { repo: string; title: string; body: string; state: string }[];
    issues: { repo: string; title: string; body: string; state: string }[];
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
  "title", "body", "state",
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
    message: t.redacted ? "" : text(c.message),
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
      prs: week.prs
        .filter((p) => !p.redacted)
        .map((p) => ({ repo: p.repo, title: text(p.title), body: text(p.body), state: p.state })),
      issues: week.issues
        .filter((i) => !i.redacted)
        .map((i) => ({ repo: i.repo, title: text(i.title), body: text(i.body), state: i.state })),
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
  assertNoSecrets(payload);
  return payload;
}
