export type Lang = "en" | "ru";

export interface PromptContext {
  devProfile: string;
  languageName: string;
}

export interface Messages {
  /** BCP 47 locale used for date and number formatting. */
  locale: string;
  /** Human-readable language name injected into the LLM prompt. */
  languageName: string;
  report: {
    heading: (title: string, weekNumber: number) => string;
    streak: (streak: number, best: number) => string;
    sections: {
      summary: string;
      projects: string;
      prs: string;
      issues: string;
      cost: string;
      achievements: string;
      coach: string;
      allTime: string;
    };
    metricsTable: { metric: string; week: string; delta: string };
    metrics: {
      commits: string;
      prs: string;
      issues: string;
      additions: string;
      deletions: string;
      ci: string;
      deployments: string;
      activeRepos: string;
    };
    projectsTable: {
      project: string;
      commits: string;
      added: string;
      removed: string;
      language: string;
    };
    commitsDetails: string;
    redactedNote: string;
    cost: {
      hours: (hours: string) => string;
      office: (money: string) => string;
      freelance: (money: string) => string;
      rates: (p: { annual: string; hourly: string; region: string; date: string }) => string;
      sources: (links: string) => string;
      noSources: string;
    };
    allTimeLine: (parts: { commits: string; prs: string; issues: string; weeks: string; achievements: string }) => string;
    generatedBy: (provider: string, model: string) => string;
  };
  achievements: Record<string, { title: string; description: string }>;
  telegram: { failed: string; newAchievements: (list: string) => string; openReport: string };
  prompt: (ctx: PromptContext) => string;
}
