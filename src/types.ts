export interface CommitInfo {
  /** First line only — what the markdown report lists. */
  headline: string;
  /** Full commit message (headline + body) — what the LLM payload gets. */
  message: string;
  date: string; // ISO
  additions: number;
  deletions: number;
  url: string;
  /** ISO. When the change was written — survives rebases, unlike `date` (committer date). */
  authoredDate?: string;
}

export interface RepoActivity {
  fullName: string;
  /** Name safe to publish: equals fullName unless the repo was redacted. */
  displayName: string;
  isPrivate: boolean;
  /** True when names, messages and links of this repo must not be exposed. */
  redacted: boolean;
  language: string | null;
  url: string;
  commits: CommitInfo[];
  additions: number;
  deletions: number;
  ciSuccess: number;
  ciFailure: number;
  deployments: number;
}

export interface PrInfo {
  title: string;
  /** Description; empty when the PR has none. */
  body: string;
  repo: string;
  isPrivate: boolean;
  redacted: boolean;
  state: "open" | "merged" | "closed";
  url: string;
}

export interface IssueInfo {
  title: string;
  /** Description; empty when the issue has none. */
  body: string;
  repo: string;
  isPrivate: boolean;
  redacted: boolean;
  state: string;
  url: string;
}

export interface WeekActivity {
  since: string; // ISO
  until: string; // ISO
  repos: RepoActivity[];
  prs: PrInfo[];
  issues: IssueInfo[];
  totalCommits: number;
  totalAdditions: number;
  totalDeletions: number;
}

export interface StateTotals {
  commits: number;
  prs: number;
  issues: number;
  additions: number;
  deletions: number;
  activeWeeks: number;
}

export interface WeekSnapshot {
  commits: number;
  prs: number;
  issues: number;
  additions: number;
  deletions: number;
}

export interface AppState {
  reportCount: number;
  streak: number;
  bestStreak: number;
  allTime: StateTotals;
  unlocked: string[];
  lastWeek: WeekSnapshot | null;
  lastRunUntil: string | null; // ISO — end of the period of the last successful run
  /** Cached market rates for the salary estimate; absent in snapshots written before it existed. */
  rates?: MarketRates | null;
}

export interface RateSource {
  title: string;
  url: string;
}

/** Market rates cached in state (see rates.ts); amounts are in `currency`. */
export interface MarketRates {
  annualGross: number;
  freelanceHourly: number;
  currency: string;
  /** Human-readable region the rates apply to, in the report language. */
  region: string;
  /** Pages the web search returned; empty = the model's own estimate without search. */
  sources: RateSource[];
  fetchedAt: string; // ISO
  /** SHA-256 of DEV_PROFILE at lookup time — the profile text itself is never stored. */
  profileHash: string;
}

/** What the week's focused hours are worth at the cached rates — computed in code. */
export interface WeekCost {
  hours: number;
  employeeWeek: number;
  freelanceWeek: number;
  rates: MarketRates;
}

/** The model's per-commit answer; `id` refers to the commit's position in the timeline. */
export interface CommitEstimate {
  id: number;
  minutes: number;
}

export interface LlmResult {
  projectSummaries: { repo: string; summary: string }[];
  commitMinutes: CommitEstimate[];
  praise: string;
  telegramMessage: string;
}

export interface AchievementDef {
  id: string;
  test: (week: WeekActivity, newStreak: number, allTimeCommits: number) => boolean;
}

export interface UnlockedAchievement {
  id: string;
  title: string;
  description: string;
}
