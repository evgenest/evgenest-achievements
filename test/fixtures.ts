import { loadConfig, type Config } from "../src/config";
import type { AppState, CommitInfo, IssueInfo, PrInfo, RepoActivity, WeekActivity } from "../src/types";

const BASE_ENV: Record<string, string> = {
  GITHUB_USER: "octocat",
  REPORTS_REPO: "octocat/reports",
  REPORT_LANG: "en",
  REPORT_TITLE: "Weekly Achievements",
  TIMEZONE: "Europe/Berlin",
  CURRENCY: "EUR",
  PRIVATE_REPOS: "full",
  ENABLE_SALARY_ESTIMATE: "true",
  LLM_PROVIDER: "openai",
  LLM_MODEL: "test-model",
  LLM_REASONING_EFFORT: "low",
  DEV_PROFILE: "Test developer.",
};

export function makeConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ ...BASE_ENV, ...overrides } as unknown as Env);
}

export function makeCommit(overrides: Partial<CommitInfo> = {}): CommitInfo {
  return {
    message: "feat: something",
    date: "2026-08-05T12:00:00Z",
    additions: 10,
    deletions: 2,
    url: "https://github.com/octocat/public-repo/commit/abc",
    ...overrides,
  };
}

export function makeRepo(overrides: Partial<RepoActivity> = {}): RepoActivity {
  const fullName = overrides.fullName ?? "octocat/public-repo";
  return {
    fullName,
    displayName: fullName,
    isPrivate: false,
    redacted: false,
    language: "TypeScript",
    url: `https://github.com/${fullName}`,
    commits: [makeCommit()],
    additions: 10,
    deletions: 2,
    ciSuccess: 0,
    ciFailure: 0,
    deployments: 0,
    ...overrides,
  };
}

export function makePr(overrides: Partial<PrInfo> = {}): PrInfo {
  return {
    title: "Add feature",
    repo: "octocat/public-repo",
    isPrivate: false,
    redacted: false,
    state: "merged",
    url: "https://github.com/octocat/public-repo/pull/1",
    ...overrides,
  };
}

export function makeIssue(overrides: Partial<IssueInfo> = {}): IssueInfo {
  return {
    title: "Something is broken",
    repo: "octocat/public-repo",
    isPrivate: false,
    redacted: false,
    state: "open",
    url: "https://github.com/octocat/public-repo/issues/1",
    ...overrides,
  };
}

export function makeWeek(overrides: Partial<WeekActivity> = {}): WeekActivity {
  const repos = overrides.repos ?? [makeRepo()];
  return {
    since: "2026-07-31T08:00:00Z",
    until: "2026-08-07T08:00:00Z",
    repos,
    prs: overrides.prs ?? [makePr()],
    issues: overrides.issues ?? [makeIssue()],
    totalCommits: repos.reduce((s, r) => s + r.commits.length, 0),
    totalAdditions: repos.reduce((s, r) => s + r.additions, 0),
    totalDeletions: repos.reduce((s, r) => s + r.deletions, 0),
    ...overrides,
  };
}

interface FakeKvEntry {
  value: string;
  metadata: unknown;
}

/** In-memory stand-in for the STATE binding: enough of the KV API for state.ts. */
export function makeKvEnv(pageSize = 1000): Env & { kv: Map<string, FakeKvEntry> } {
  const kv = new Map<string, FakeKvEntry>();
  const STATE = {
    async get(key: string, _type?: string) {
      const entry = kv.get(key);
      return entry ? JSON.parse(entry.value) : null;
    },
    async put(key: string, value: string, options?: { metadata?: unknown }) {
      kv.set(key, { value, metadata: options?.metadata ?? null });
    },
    async delete(key: string) {
      kv.delete(key);
    },
    async list({ prefix = "", cursor }: { prefix?: string; cursor?: string } = {}) {
      const names = [...kv.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? names.indexOf(cursor) : 0;
      const page = names.slice(start, start + pageSize);
      const next = names[start + pageSize];
      return {
        keys: page.map((name) => ({ name, metadata: kv.get(name)?.metadata ?? undefined })),
        list_complete: next === undefined,
        cursor: next,
      };
    },
  };
  return { STATE, kv } as unknown as Env & { kv: Map<string, FakeKvEntry> };
}

export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    reportCount: 0,
    streak: 0,
    bestStreak: 0,
    allTime: { commits: 0, prs: 0, issues: 0, additions: 0, deletions: 0, activeWeeks: 0 },
    unlocked: [],
    lastWeek: null,
    lastRunUntil: null,
    ...overrides,
  };
}
