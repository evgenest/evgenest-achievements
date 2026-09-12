import type { Config } from "./config";
import { formatDate } from "./time";
import type { AppState, LlmResult, UnlockedAchievement, WeekActivity, WeekCost } from "./types";

export interface ReportParams {
  config: Config;
  week: WeekActivity;
  state: AppState; // state BEFORE this week
  newStreak: number;
  achievements: UnlockedAchievement[];
  llm: LlmResult;
  /** Hours × cached market rates, computed in code; null when disabled or no rates are known. */
  cost: WeekCost | null;
}

function delta(current: number, prev: number | undefined, num: (n: number) => string): string {
  if (prev === undefined) return "—";
  const d = current - prev;
  return d === 0 ? "=" : d > 0 ? `+${num(d)}` : num(d);
}

function link(text: string, url: string): string {
  return url ? `[${text}](${url})` : text;
}

export function buildReport({ config, week, state, newStreak, achievements, llm, cost }: ReportParams): string {
  const m = config.messages.report;
  const fmtDay = (iso: string): string => formatDate(iso, config.messages.locale, config.timezone);
  const num = (n: number): string => n.toLocaleString(config.messages.locale);
  const money = (n: number): string =>
    new Intl.NumberFormat(config.messages.locale, {
      style: "currency",
      currency: config.currency,
      maximumFractionDigits: 0,
    }).format(Math.round(n));

  const weekNumber = state.reportCount + 1;
  const prev = state.lastWeek ?? undefined;
  const lines: string[] = [];

  lines.push(m.heading(config.reportTitle, weekNumber));
  lines.push(`_${fmtDay(week.since)} — ${fmtDay(week.until)}_`);
  lines.push("");
  lines.push(m.streak(newStreak, Math.max(state.bestStreak, newStreak)));
  lines.push("");

  lines.push(`## ${m.sections.summary}`);
  lines.push("");
  lines.push(`| ${m.metricsTable.metric} | ${m.metricsTable.week} | ${m.metricsTable.delta} |`);
  lines.push("|---|---:|---:|");
  lines.push(`| ${m.metrics.commits} | ${num(week.totalCommits)} | ${delta(week.totalCommits, prev?.commits, num)} |`);
  lines.push(`| ${m.metrics.prs} | ${num(week.prs.length)} | ${delta(week.prs.length, prev?.prs, num)} |`);
  lines.push(`| ${m.metrics.issues} | ${num(week.issues.length)} | ${delta(week.issues.length, prev?.issues, num)} |`);
  lines.push(
    `| ${m.metrics.additions} | ${num(week.totalAdditions)} | ${delta(week.totalAdditions, prev?.additions, num)} |`,
  );
  lines.push(
    `| ${m.metrics.deletions} | ${num(week.totalDeletions)} | ${delta(week.totalDeletions, prev?.deletions, num)} |`,
  );
  const ciSuccess = week.repos.reduce((s, r) => s + r.ciSuccess, 0);
  const ciFailure = week.repos.reduce((s, r) => s + r.ciFailure, 0);
  const deployments = week.repos.reduce((s, r) => s + r.deployments, 0);
  lines.push(`| ${m.metrics.ci} | ${num(ciSuccess)} / ${num(ciFailure)} | — |`);
  lines.push(`| ${m.metrics.deployments} | ${num(deployments)} | — |`);
  lines.push(`| ${m.metrics.activeRepos} | ${num(week.repos.length)} | — |`);
  lines.push("");

  if (week.repos.length > 0) {
    lines.push(`## ${m.sections.projects}`);
    lines.push("");
    lines.push(
      `| ${m.projectsTable.project} | ${m.projectsTable.commits} | ${m.projectsTable.added} | ${m.projectsTable.removed} | ${m.projectsTable.language} |`,
    );
    lines.push("|---|---:|---:|---:|---|");
    for (const r of week.repos) {
      lines.push(
        `| ${link(r.displayName, r.url)} | ${num(r.commits.length)} | ${num(r.additions)} | ${num(r.deletions)} | ${r.language ?? "—"} |`,
      );
    }
    lines.push("");

    for (const r of week.repos) {
      lines.push(`### ${r.displayName}`);
      lines.push("");
      const summary = llm.projectSummaries.find((s) => s.repo === r.displayName)?.summary;
      if (summary) {
        lines.push(summary);
        lines.push("");
      }
      if (r.redacted) {
        lines.push(m.redactedNote);
        lines.push("");
        continue;
      }
      lines.push(`<details><summary>${m.commitsDetails}</summary>`);
      lines.push("");
      for (const c of r.commits) {
        lines.push(`- ${link(`\`${fmtDay(c.date)}\``, c.url)} ${c.message} (+${num(c.additions)}/−${num(c.deletions)})`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  const visiblePrs = week.prs.filter((p) => !p.redacted);
  if (visiblePrs.length > 0) {
    lines.push(`## ${m.sections.prs}`);
    lines.push("");
    for (const p of visiblePrs) {
      lines.push(`- **[${p.state}]** ${link(p.title, p.url)} — ${p.repo}`);
    }
    lines.push("");
  }

  const visibleIssues = week.issues.filter((i) => !i.redacted);
  if (visibleIssues.length > 0) {
    lines.push(`## ${m.sections.issues}`);
    lines.push("");
    for (const i of visibleIssues) {
      lines.push(`- **[${i.state}]** ${link(i.title, i.url)} — ${i.repo}`);
    }
    lines.push("");
  }

  // An empty week gets no price tag — pauses are part of the work.
  if (config.salaryEstimate && cost && cost.hours > 0) {
    const r = cost.rates;
    lines.push(`## ${m.sections.cost}`);
    lines.push("");
    lines.push(m.cost.hours(cost.hours.toLocaleString(config.messages.locale, { maximumFractionDigits: 1 })));
    lines.push(m.cost.office(money(cost.employeeWeek)));
    lines.push(m.cost.freelance(money(cost.freelanceWeek)));
    lines.push("");
    lines.push(
      `_${m.cost.rates({ annual: money(r.annualGross), hourly: money(r.freelanceHourly), region: r.region, date: fmtDay(r.fetchedAt) })}_`,
    );
    lines.push("");
    lines.push(
      r.sources.length > 0 ? m.cost.sources(r.sources.map((s) => link(s.title, s.url)).join(" · ")) : `_${m.cost.noSources}_`,
    );
    lines.push("");
  }

  if (achievements.length > 0) {
    lines.push(`## ${m.sections.achievements}`);
    lines.push("");
    for (const a of achievements) {
      lines.push(`- **${a.title}** — ${a.description}`);
    }
    lines.push("");
  }

  lines.push(`## ${m.sections.coach}`);
  lines.push("");
  lines.push(llm.praise);
  lines.push("");

  lines.push(`## ${m.sections.allTime}`);
  lines.push("");
  const at = state.allTime;
  const activeThisWeek = week.totalCommits + week.prs.length + week.issues.length > 0 ? 1 : 0;
  lines.push(
    m.allTimeLine({
      commits: num(at.commits + week.totalCommits),
      prs: num(at.prs + week.prs.length),
      issues: num(at.issues + week.issues.length),
      weeks: num(at.activeWeeks + activeThisWeek),
      achievements: num(state.unlocked.length + achievements.length),
    }),
  );
  lines.push("");

  lines.push(m.generatedBy(config.llm.provider, config.llm.model));
  lines.push("");

  return lines.join("\n");
}
