import type { AchievementDef, AppState, UnlockedAchievement, WeekActivity } from "./types";

function berlinHour(iso: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", hour: "2-digit", hour12: false }).format(
      new Date(iso),
    ),
  );
}

const DEFS: AchievementDef[] = [
  {
    id: "first-report",
    title: "Начало положено",
    description: "Первый еженедельный отчёт",
    test: () => true,
  },
  {
    id: "marathon",
    title: "Марафонец",
    description: "10+ коммитов за неделю",
    test: (w) => w.totalCommits >= 10,
  },
  {
    id: "sprinter",
    title: "Спринтер",
    description: "25+ коммитов за неделю",
    test: (w) => w.totalCommits >= 25,
  },
  {
    id: "shipper",
    title: "Shipper",
    description: "Смёрджен pull request",
    test: (w) => w.prs.some((p) => p.state === "merged"),
  },
  {
    id: "polyglot",
    title: "Полиглот",
    description: "3+ языка за одну неделю",
    test: (w) => new Set(w.repos.map((r) => r.language).filter(Boolean)).size >= 3,
  },
  {
    id: "night-owl",
    title: "Ночная сова",
    description: "Коммит между полуночью и 6 утра",
    test: (w) => w.repos.some((r) => r.commits.some((c) => berlinHour(c.date) < 6)),
  },
  {
    id: "multitasker",
    title: "Мультитаскер",
    description: "3+ активных проекта за неделю",
    test: (w) => w.repos.length >= 3,
  },
  {
    id: "kilo-week",
    title: "Тысячник",
    description: "1000+ строк добавлено за неделю",
    test: (w) => w.totalAdditions >= 1000,
  },
  {
    id: "deployer",
    title: "В продакшен!",
    description: "Деплой за неделю",
    test: (w) => w.repos.reduce((s, r) => s + r.deployments, 0) >= 1,
  },
  {
    id: "green-week",
    title: "Зелёная неделя",
    description: "5+ CI-прогонов, все успешные",
    test: (w) => {
      const ok = w.repos.reduce((s, r) => s + r.ciSuccess, 0);
      const fail = w.repos.reduce((s, r) => s + r.ciFailure, 0);
      return ok >= 5 && fail === 0;
    },
  },
  {
    id: "streak-4",
    title: "Месяц в строю",
    description: "4 активные недели подряд",
    test: (_w, streak) => streak >= 4,
  },
  {
    id: "streak-8",
    title: "Два месяца в строю",
    description: "8 активных недель подряд",
    test: (_w, streak) => streak >= 8,
  },
  {
    id: "streak-12",
    title: "Квартал в строю",
    description: "12 активных недель подряд",
    test: (_w, streak) => streak >= 12,
  },
  {
    id: "century",
    title: "Сотня",
    description: "100 коммитов суммарно",
    test: (w, _s, allTimeCommits) => allTimeCommits + w.totalCommits >= 100,
  },
];

export function detectAchievements(week: WeekActivity, state: AppState, newStreak: number): UnlockedAchievement[] {
  return DEFS.filter(
    (d) => !state.unlocked.includes(d.id) && d.test(week, newStreak, state.allTime.commits),
  ).map(({ id, title, description }) => ({ id, title, description }));
}
