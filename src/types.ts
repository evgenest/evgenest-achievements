export interface CommitInfo {
  message: string;
  date: string; // ISO
  additions: number;
  deletions: number;
  url: string;
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
  repo: string;
  isPrivate: boolean;
  redacted: boolean;
  state: "open" | "merged" | "closed";
  url: string;
}

export interface IssueInfo {
  title: string;
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
}

export interface SalaryEstimate {
  /** Amounts are in the currency configured via CURRENCY. */
  employeeWeek: number;
  freelanceWeek: number;
  rationale: string;
}

export interface LlmResult {
  projectSummaries: { repo: string; summary: string }[];
  hoursEstimate: number;
  /** Present only when ENABLE_SALARY_ESTIMATE is on. */
  salary?: SalaryEstimate;
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
