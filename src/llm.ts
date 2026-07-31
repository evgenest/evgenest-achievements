import { buildLlmPayload } from "./sanitize";
import type { AppState, LlmResult, WeekActivity } from "./types";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["projectSummaries", "hoursEstimate", "salary", "praise", "telegramMessage"],
  properties: {
    projectSummaries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["repo", "summary"],
        properties: {
          repo: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
    hoursEstimate: { type: "number" },
    salary: {
      type: "object",
      additionalProperties: false,
      required: ["employeeWeekEur", "freelanceWeekEur", "rationale"],
      properties: {
        employeeWeekEur: { type: "number" },
        freelanceWeekEur: { type: "number" },
        rationale: { type: "string" },
      },
    },
    praise: { type: "string" },
    telegramMessage: { type: "string" },
  },
} as const;

function systemPrompt(env: Env): string {
  return `Ты — опытный tech lead и тёплый, но честный карьерный коуч. Твоя задача — помочь разработчику увидеть и оценить реальные результаты его недели. Он склонен обесценивать свою работу, поэтому подчёркивай достижения, но только по фактам — без пустой лести и сиропа.

Профиль разработчика: ${env.DEV_PROFILE}

Отвечай на языке: ${env.REPORT_LANG === "ru" ? "русский" : "английский"}.

Правила:
- projectSummaries: для каждого репозитория из данных — 2-5 предложений человеческим языком о том, что было сделано ПО СУТИ (бизнес-логика, ценность), а не пересказ сообщений коммитов. Ключ repo — полное имя репозитория как в данных.
- hoursEstimate: реалистичная оценка чистых часов работы за неделю по объёму и сложности изменений.
- salary: сколько такая неделя стоила бы на рынке. employeeWeekEur — недельная доля брутто-зарплаты офисного разработчика такого профиля (город из профиля), пропорционально оценённым часам. freelanceWeekEur — те же часы по рыночной фриланс-ставке. rationale — 1-2 предложения с использованными ставками.
- praise: 3-6 предложений — «слово тренера»: что впечатляет в этой неделе, какой прогресс виден, что это говорит о разработчике. Конкретика, не общие слова.
- telegramMessage: короткое сообщение 2-4 предложения для Telegram: приветствие, 1-2 самые яркие цифры или факта недели, ободрение. Разметка только <b> и <i> (HTML Telegram). Без ссылок — ссылку на отчёт добавит код.
- Если неделя пустая или почти пустая: бережный тон, отдых и пауза — нормальная часть работы, без стыда и упрёков.`;
}

export async function generateInsights(env: Env, week: WeekActivity, state: AppState, newStreak: number): Promise<LlmResult> {
  // Через границу в OpenAI данные проходят ТОЛЬКО через страж (см. sanitize.ts)
  const input = buildLlmPayload(week, state, newStreak);

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-5.6-luna",
      reasoning: { effort: "medium" },
      instructions: systemPrompt(env),
      input: `Данные активности за неделю (JSON):\n${JSON.stringify(input)}`,
      text: {
        format: {
          type: "json_schema",
          name: "weekly_insights",
          strict: true,
          schema: SCHEMA,
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenAI -> ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    output?: { type: string; content?: { type: string; text?: string }[] }[];
  };
  const message = data.output?.find((o) => o.type === "message");
  const text = message?.content?.find((c) => c.type === "output_text")?.text;
  if (!text) {
    throw new Error(`OpenAI: no output_text in response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return JSON.parse(text) as LlmResult;
}
