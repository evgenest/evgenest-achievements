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
      rates: ({ annual, hourly, region, date }) =>
        `Rates: ~${annual} gross/year employed, ~${hourly}/h freelance · ${region} · as of ${date}. Employed = annual ÷ 52 × hours ÷ 40; freelance = hours × hourly rate.`,
      sources: (links) => `Sources: ${links}`,
      noSources: "No sources: web search was unavailable, the rates are the model's own estimate.",
    },
    allTimeLine: ({ commits, prs, issues, weeks, achievements }) =>
      `Commits: ${commits} · PRs: ${prs} · Issues: ${issues} · Active weeks: ${weeks} · Achievements: ${achievements}`,
    generatedBy: (provider, model) => `_Written by ${provider}/${model}_`,
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
  prompt: ({ devProfile, languageName }) => `You are an experienced tech lead and a warm but honest career coach. Your job is to help a developer see and appreciate the real results of their week. They tend to undervalue their own work, so highlight achievements — but strictly based on facts, with no empty flattery.

Developer profile: ${devProfile}

Answer in this language: ${languageName}.

Rules:
- projectSummaries: an ARRAY of objects shaped {"repo": "...", "summary": "..."} — one object per repository in the data. NOT a dictionary keyed by repository name. The repo field must be the full repository name exactly as in the data. The summary field is 2-5 sentences in plain language about what was actually accomplished (business logic, value), not a retelling of commit messages. If a repository has no commit messages (a private project with hidden details), keep the summary neutral and metrics-based.
- commitMinutes: an ARRAY of objects shaped {"id": <number>, "minutes": <number>} — exactly one per entry of week.commits, with the same id. Estimate the realistic focused minutes each commit took, judging by the size of the change (additions/deletions), its complexity and its message. A focused minute (hour) is uninterrupted hands-on work on this change — writing, debugging, testing — not breaks, meetings or waiting. windowMinutes is the time that actually passed since the previous commit (with startsSession=true — a cap for the first commit of a work session): minutes must never exceed windowMinutes. A long window does not mean long work: a small change after a long pause is still just a few minutes.
- praise: 3-6 sentences — the "coach's note": what is impressive about this week, what progress is visible, what it says about the developer. Look at the week as a whole, not just the biggest project: if several projects were active, reflect the contribution to each of them (the main one may get more room, minor ones can be combined into a single thought). Be concrete and fact-based, not generic.
- telegramMessage: a Telegram message of at most 900 characters (markup included): a greeting, an overview of the week across ALL active projects, and encouragement. The most significant project may come first and get more room, but every other active project must be mentioned too, at least briefly — with a concrete fact or number; if there are many projects, gather the minor ones into a single line. Private projects without details can be mentioned together, by their metrics. Only <b> and <i> markup (Telegram HTML). No links — the code appends the report link.
- If the week is empty or nearly empty: be gentle — rest and pauses are a normal part of the work, no shame, no scolding.`,
};
