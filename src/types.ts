export interface CommitInfo {
  message: string;
  date: string; // ISO
  additions: number;
  deletions: number;
  url: string;
}

export interface RepoActivity {
  fullName: string;
  isPrivate: boolean;
  language: string | null;
  url: string;
  commits: CommitInfo[];
  additions: number;
  deletions: number;
}

export interface PrInfo {
  title: string;
  repo: string;
  state: "open" | "merged" | "closed";
  url: string;
}

export interface IssueInfo {
  title: string;
  repo: string;
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
}

export interface LlmResult {
  projectSummaries: { repo: string; summary: string }[];
  hoursEstimate: number;
  salary: {
    employeeWeekEur: number;
    freelanceWeekEur: number;
    rationale: string;
  };
  praise: string;
  telegramMessage: string;
}

export interface AchievementDef {
  id: string;
  title: string;
  description: string;
  test: (week: WeekActivity, newStreak: number, allTimeCommits: number) => boolean;
}

export interface UnlockedAchievement {
  id: string;
  title: string;
  description: string;
}
