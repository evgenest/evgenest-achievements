import type { AppState, WeekActivity } from "./types";

/**
 * Страж данных: ЕДИНСТВЕННАЯ точка формирования payload для OpenAI.
 *
 * Гарантии:
 * 1. Payload собирается явной проекцией — только перечисленные ниже примитивы
 *    (заголовки коммитов, названия PR/issues, счётчики, даты, языки).
 *    Код, диффы, патчи, содержимое файлов, URL — не попадают сюда by construction.
 * 2. assertSanitized() рекурсивно сверяет каждый ключ готового payload
 *    с allowlist и бросает ошибку на любом незнакомом ключе (fail-closed):
 *    если кто-то расширит типы активности, отправка в LLM упадёт, а не утечёт.
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
      commitMessages: string[];
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
  "ciSuccess", "ciFailure", "deployments", "commitMessages",
  "title", "state",
  "weekNumber", "streakWeeks", "bestStreak", "allTime", "lastWeek",
  "commits", "activeWeeks",
]);

export function assertSanitized(value: unknown, path = "$"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSanitized(v, `${path}[${i}]`));
    return;
  }
  for (const [key, v] of Object.entries(value)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`LLM payload guard: незнакомый ключ "${key}" в ${path} — отправка в OpenAI заблокирована`);
    }
    assertSanitized(v, `${path}.${key}`);
  }
}

export function buildLlmPayload(week: WeekActivity, state: AppState, newStreak: number): LlmPayload {
  const payload: LlmPayload = {
    week: {
      since: week.since,
      until: week.until,
      repos: week.repos.map((r) => ({
        repo: r.fullName,
        language: r.language,
        commitCount: r.commits.length,
        additions: r.additions,
        deletions: r.deletions,
        ciSuccess: r.ciSuccess,
        ciFailure: r.ciFailure,
        deployments: r.deployments,
        commitMessages: r.commits.map((c) => clip(c.message)),
      })),
      prs: week.prs.map((p) => ({ repo: p.repo, title: clip(p.title), state: p.state })),
      issues: week.issues.map((i) => ({ repo: i.repo, title: clip(i.title), state: i.state })),
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
