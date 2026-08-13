import type { Messages } from "./types";

export const ru: Messages = {
  locale: "ru-RU",
  languageName: "русский",
  report: {
    heading: (title, weekNumber) => `# ${title} — неделя #${weekNumber}`,
    streak: (streak, best) => `**Стрик: ${streak} нед. подряд** (рекорд: ${best})`,
    sections: {
      summary: "Итоги недели",
      projects: "Проекты",
      prs: "Pull requests",
      issues: "Issues",
      cost: "Сколько это стоило бы",
      achievements: "Новые ачивки",
      coach: "Слово тренера",
      allTime: "All-time",
    },
    metricsTable: { metric: "Метрика", week: "За неделю", delta: "Δ к прошлой" },
    metrics: {
      commits: "Коммиты",
      prs: "Pull requests",
      issues: "Issues",
      additions: "Строк добавлено",
      deletions: "Строк удалено",
      ci: "CI-прогоны (успешные/упавшие)",
      deployments: "Деплои",
      activeRepos: "Активных проектов",
    },
    projectsTable: {
      project: "Проект",
      commits: "Коммиты",
      added: "+строк",
      removed: "−строк",
      language: "Язык",
    },
    commitsDetails: "Коммиты",
    redactedNote: "_Приватный репозиторий: детали скрыты, учтены только метрики._",
    cost: {
      hours: (hours) => `- Оценка чистых часов: **~${hours} ч**`,
      office: (money) => `- В офисе: **~${money}** за неделю`,
      freelance: (money) => `- На фрилансе: **~${money}** за неделю`,
    },
    allTimeLine: ({ commits, prs, issues, weeks, achievements }) =>
      `Коммитов: ${commits} · PR: ${prs} · Issues: ${issues} · Активных недель: ${weeks} · Ачивок: ${achievements}`,
  },
  achievements: {
    "first-report": { title: "Начало положено", description: "Первый еженедельный отчёт" },
    marathon: { title: "Марафонец", description: "10+ коммитов за неделю" },
    sprinter: { title: "Спринтер", description: "25+ коммитов за неделю" },
    shipper: { title: "Shipper", description: "Смёрджен pull request" },
    polyglot: { title: "Полиглот", description: "3+ языка за одну неделю" },
    "night-owl": { title: "Ночная сова", description: "Коммит между полуночью и 6 утра" },
    multitasker: { title: "Мультитаскер", description: "3+ активных проекта за неделю" },
    "kilo-week": { title: "Тысячник", description: "1000+ строк добавлено за неделю" },
    deployer: { title: "В продакшен!", description: "Деплой за неделю" },
    "green-week": { title: "Зелёная неделя", description: "5+ CI-прогонов, все успешные" },
    "streak-4": { title: "Месяц в строю", description: "4 активные недели подряд" },
    "streak-8": { title: "Два месяца в строю", description: "8 активных недель подряд" },
    "streak-12": { title: "Квартал в строю", description: "12 активных недель подряд" },
    century: { title: "Сотня", description: "100 коммитов суммарно" },
  },
  telegram: {
    failed: "⚠️ Еженедельный отчёт не сформирован — ошибка при обработке. Подробности в логах Workers.",
    newAchievements: (list) => `Новые ачивки: ${list}`,
    openReport: "Открыть полный отчёт",
  },
  prompt: ({ devProfile, languageName, currency, salaryEstimate }) => `Ты — опытный tech lead и тёплый, но честный карьерный коуч. Твоя задача — помочь разработчику увидеть и оценить реальные результаты его недели. Он склонен обесценивать свою работу, поэтому подчёркивай достижения, но только по фактам — без пустой лести и сиропа.

Профиль разработчика: ${devProfile}

Отвечай на языке: ${languageName}.

Правила:
- projectSummaries: МАССИВ объектов вида {"repo": "...", "summary": "..."} — по одному объекту на каждый репозиторий из данных. НЕ объект/словарь с именами репозиториев в качестве ключей. Поле repo — полное имя репозитория как в данных. Поле summary — 2-5 предложений человеческим языком о том, что было сделано ПО СУТИ (бизнес-логика, ценность), а не пересказ сообщений коммитов. Если у репозитория нет сообщений коммитов (приватный проект со скрытыми деталями) — ограничься нейтральной формулировкой по метрикам.
- hoursEstimate: реалистичная оценка чистых часов работы за неделю по объёму и сложности изменений.${
    salaryEstimate
      ? `
- salary: сколько такая неделя стоила бы на рынке, в валюте ${currency}. employeeWeek — недельная доля брутто-зарплаты штатного разработчика такого профиля (регион из профиля), пропорционально оценённым часам. freelanceWeek — те же часы по рыночной фриланс-ставке. rationale — 1-2 предложения с использованными ставками.`
      : ""
  }
- praise: 3-6 предложений — «слово тренера»: что впечатляет в этой неделе, какой прогресс виден, что это говорит о разработчике. Конкретика, не общие слова.
- telegramMessage: короткое сообщение 2-4 предложения для Telegram: приветствие, 1-2 самые яркие цифры или факта недели, ободрение. Разметка только <b> и <i> (HTML Telegram). Без ссылок — ссылку на отчёт добавит код.
- Если неделя пустая или почти пустая: бережный тон, отдых и пауза — нормальная часть работы, без стыда и упрёков.`,
};
