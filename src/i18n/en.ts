import type { Messages } from "./types";

export const en: Messages = {
  locale: "en-US",
  languageName: "English",
  report: {
    heading: (title, weekNumber) => `# ${title} — week #${weekNumber}`,
    streak: (streak, best) => `**Streak: ${streak} week(s) in a row** (best: ${best})`,
    sections: {
      summary: "Week at a glance",
      projects: "Projects",
      prs: "Pull requests",
      issues: "Issues",
      cost: "What this week was worth",
      achievements: "New achievements",
      coach: "Coach's note",
      allTime: "All-time",
    },
    metricsTable: { metric: "Metric", week: "This week", delta: "Δ vs last" },
    metrics: {
      commits: "Commits",
      prs: "Pull requests",
      issues: "Issues",
      additions: "Lines added",
      deletions: "Lines removed",
      ci: "CI runs (passed/failed)",
      deployments: "Deployments",
      activeRepos: "Active projects",
    },
    projectsTable: {
      project: "Project",
      commits: "Commits",
      added: "+lines",
      removed: "−lines",
      language: "Language",
    },
    commitsDetails: "Commits",
    redactedNote: "_Private repository: details hidden, metrics only._",
    cost: {
      hours: (hours) => `- Estimated focused hours: **~${hours} h**`,
      office: (money) => `- Employed: **~${money}** for the week`,
      freelance: (money) => `- Freelance: **~${money}** for the week`,
    },
    allTimeLine: ({ commits, prs, issues, weeks, achievements }) =>
      `Commits: ${commits} · PRs: ${prs} · Issues: ${issues} · Active weeks: ${weeks} · Achievements: ${achievements}`,
  },
  achievements: {
    "first-report": { title: "Off the ground", description: "First weekly report" },
    marathon: { title: "Marathoner", description: "10+ commits in a week" },
    sprinter: { title: "Sprinter", description: "25+ commits in a week" },
    shipper: { title: "Shipper", description: "A pull request got merged" },
    polyglot: { title: "Polyglot", description: "3+ languages in a single week" },
    "night-owl": { title: "Night owl", description: "A commit between midnight and 6am" },
    multitasker: { title: "Multitasker", description: "3+ active projects in a week" },
    "kilo-week": { title: "Kilo week", description: "1000+ lines added in a week" },
    deployer: { title: "Shipped to prod", description: "At least one deployment this week" },
    "green-week": { title: "Green week", description: "5+ CI runs, all green" },
    "streak-4": { title: "A month in", description: "4 active weeks in a row" },
    "streak-8": { title: "Two months in", description: "8 active weeks in a row" },
    "streak-12": { title: "A quarter in", description: "12 active weeks in a row" },
    century: { title: "Century", description: "100 commits all-time" },
  },
  telegram: {
    failed: "⚠️ The weekly report could not be generated — processing failed. Details are in the Workers logs.",
    newAchievements: (list) => `New achievements: ${list}`,
    openReport: "Open the full report",
  },
  prompt: ({ devProfile, languageName, currency, salaryEstimate }) => `You are an experienced tech lead and a warm but honest career coach. Your job is to help a developer see and appreciate the real results of their week. They tend to undervalue their own work, so highlight achievements — but strictly based on facts, with no empty flattery.

Developer profile: ${devProfile}

Answer in this language: ${languageName}.

Rules:
- projectSummaries: an ARRAY of objects shaped {"repo": "...", "summary": "..."} — one object per repository in the data. NOT a dictionary keyed by repository name. The repo field must be the full repository name exactly as in the data. The summary field is 2-5 sentences in plain language about what was actually accomplished (business logic, value), not a retelling of commit messages. If a repository has no commit messages (a private project with hidden details), keep the summary neutral and metrics-based.
- hoursEstimate: a realistic estimate of focused working hours for the week, based on the volume and complexity of the changes.${
    salaryEstimate
      ? `
- salary: what such a week would be worth on the market, in ${currency}. employeeWeek — the weekly share of a gross salary for an employed developer with this profile (region from the profile), proportional to the estimated hours. freelanceWeek — the same hours at a market freelance rate. rationale — 1-2 sentences naming the rates used.`
      : ""
  }
- praise: 3-6 sentences — the "coach's note": what is impressive about this week, what progress is visible, what it says about the developer. Be concrete, not generic.
- telegramMessage: a short 2-4 sentence Telegram message: a greeting, the 1-2 most striking numbers or facts of the week, and encouragement. Only <b> and <i> markup (Telegram HTML). No links — the code appends the report link.
- If the week is empty or nearly empty: be gentle — rest and pauses are a normal part of the work, no shame, no scolding.`,
};
