import type { AppState, LlmResult, UnlockedAchievement, WeekActivity } from "./types";

function fmtDate(iso: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Berlin", dateStyle: "medium" }).format(new Date(iso));
}

function num(n: number): string {
  return n.toLocaleString("ru-RU");
}

function delta(current: number, prev: number | undefined): string {
  if (prev === undefined) return "—";
  const d = current - prev;
  return d === 0 ? "=" : d > 0 ? `+${num(d)}` : num(d);
}

export interface ReportParams {
  week: WeekActivity;
  state: AppState; // состояние ДО этой недели
  newStreak: number;
  achievements: UnlockedAchievement[];
  llm: LlmResult;
}

export function buildReport({ week, state, newStreak, achievements, llm }: ReportParams): string {
  const weekNumber = state.reportCount + 1;
  const prev = state.lastWeek ?? undefined;
  const lines: string[] = [];

  lines.push(`# EVGENEST Achievements — неделя #${weekNumber}`);
  lines.push(`_${fmtDate(week.since)} — ${fmtDate(week.until)}_`);
  lines.push("");
  lines.push(`**Стрик: ${newStreak} нед. подряд** (рекорд: ${Math.max(state.bestStreak, newStreak)})`);
  lines.push("");

  lines.push("## Итоги недели");
  lines.push("");
  lines.push("| Метрика | За неделю | Δ к прошлой |");
  lines.push("|---|---:|---:|");
  lines.push(`| Коммиты | ${num(week.totalCommits)} | ${delta(week.totalCommits, prev?.commits)} |`);
  lines.push(`| Pull requests | ${num(week.prs.length)} | ${delta(week.prs.length, prev?.prs)} |`);
  lines.push(`| Issues | ${num(week.issues.length)} | ${delta(week.issues.length, prev?.issues)} |`);
  lines.push(`| Строк добавлено | ${num(week.totalAdditions)} | ${delta(week.totalAdditions, prev?.additions)} |`);
  lines.push(`| Строк удалено | ${num(week.totalDeletions)} | ${delta(week.totalDeletions, prev?.deletions)} |`);
  const ciSuccess = week.repos.reduce((s, r) => s + r.ciSuccess, 0);
  const ciFailure = week.repos.reduce((s, r) => s + r.ciFailure, 0);
  const deployments = week.repos.reduce((s, r) => s + r.deployments, 0);
  lines.push(`| CI-прогоны (успешные/упавшие) | ${num(ciSuccess)} / ${num(ciFailure)} | — |`);
  lines.push(`| Деплои | ${num(deployments)} | — |`);
  lines.push(`| Активных проектов | ${num(week.repos.length)} | — |`);
  lines.push("");

  if (week.repos.length > 0) {
    lines.push("## Проекты");
    lines.push("");
    lines.push("| Проект | Коммиты | +строк | −строк | Язык |");
    lines.push("|---|---:|---:|---:|---|");
    for (const r of week.repos) {
      lines.push(
        `| [${r.fullName}](${r.url}) | ${num(r.commits.length)} | ${num(r.additions)} | ${num(r.deletions)} | ${r.language ?? "—"} |`,
      );
    }
    lines.push("");

    for (const r of week.repos) {
      lines.push(`### ${r.fullName}`);
      lines.push("");
      const summary = llm.projectSummaries.find((s) => s.repo === r.fullName)?.summary;
      if (summary) {
        lines.push(summary);
        lines.push("");
      }
      lines.push("<details><summary>Коммиты</summary>");
      lines.push("");
      for (const c of r.commits) {
        lines.push(`- [\`${fmtDate(c.date)}\`](${c.url}) ${c.message} (+${num(c.additions)}/−${num(c.deletions)})`);
      }
      lines.push("");
      lines.push("</details>");
      lines.push("");
    }
  }

  if (week.prs.length > 0) {
    lines.push("## Pull requests");
    lines.push("");
    for (const p of week.prs) {
      const badge = p.state === "merged" ? "merged" : p.state;
      lines.push(`- **[${badge}]** [${p.title}](${p.url}) — ${p.repo}`);
    }
    lines.push("");
  }

  if (week.issues.length > 0) {
    lines.push("## Issues");
    lines.push("");
    for (const i of week.issues) {
      lines.push(`- **[${i.state}]** [${i.title}](${i.url}) — ${i.repo}`);
    }
    lines.push("");
  }

  lines.push("## Сколько это стоило бы");
  lines.push("");
  lines.push(`- Оценка чистых часов: **~${num(Math.round(llm.hoursEstimate))} ч**`);
  lines.push(`- В офисе: **~€${num(Math.round(llm.salary.employeeWeekEur))}** за неделю`);
  lines.push(`- На фрилансе: **~€${num(Math.round(llm.salary.freelanceWeekEur))}** за неделю`);
  lines.push("");
  lines.push(`_${llm.salary.rationale}_`);
  lines.push("");

  if (achievements.length > 0) {
    lines.push("## Новые ачивки");
    lines.push("");
    for (const a of achievements) {
      lines.push(`- **${a.title}** — ${a.description}`);
    }
    lines.push("");
  }

  lines.push("## Слово тренера");
  lines.push("");
  lines.push(llm.praise);
  lines.push("");

  lines.push("## All-time");
  lines.push("");
  const at = state.allTime;
  lines.push(
    `Коммитов: ${num(at.commits + week.totalCommits)} · PR: ${num(at.prs + week.prs.length)} · Issues: ${num(at.issues + week.issues.length)} · Активных недель: ${num(at.activeWeeks + (week.totalCommits + week.prs.length + week.issues.length > 0 ? 1 : 0))} · Ачивок: ${num(state.unlocked.length + achievements.length)}`,
  );
  lines.push("");

  return lines.join("\n");
}
