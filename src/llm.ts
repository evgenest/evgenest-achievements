import { createGateway } from "@ai-sdk/gateway";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import { buildLlmPayload } from "./sanitize";
import type { AppState, LlmResult, WeekActivity } from "./types";

// Единая схема: используется и для реальной рантайм-валидации (Vercel/generateText),
// и как источник JSON Schema для OpenAI Responses API.
const RESULT_SCHEMA = z.strictObject({
  projectSummaries: z.array(z.strictObject({ repo: z.string(), summary: z.string() })),
  hoursEstimate: z.number(),
  salary: z.strictObject({
    employeeWeekEur: z.number(),
    freelanceWeekEur: z.number(),
    rationale: z.string(),
  }),
  praise: z.string(),
  telegramMessage: z.string(),
}) satisfies z.ZodType<LlmResult>;

function jsonSchemaForOpenAI() {
  const { $schema, ...schema } = z.toJSONSchema(RESULT_SCHEMA);
  return schema;
}

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

async function callOpenAI(env: Env, instructions: string, input: unknown): Promise<LlmResult> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.LLM_MODEL,
      reasoning: { effort: env.LLM_REASONING_EFFORT },
      instructions,
      input: `Данные активности за неделю (JSON):\n${JSON.stringify(input)}`,
      text: {
        format: {
          type: "json_schema",
          name: "weekly_insights",
          strict: true,
          schema: jsonSchemaForOpenAI(),
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
  try {
    return RESULT_SCHEMA.parse(JSON.parse(text));
  } catch (err) {
    console.error(JSON.stringify({ event: "llm_schema_mismatch", provider: "openai", model: env.LLM_MODEL, text, error: String(err) }));
    throw err;
  }
}

// Vercel AI Gateway: единая точка оплаты и роутинга к тем же моделям OpenAI,
// когда напрямую платить OpenAI неудобно.
async function callVercel(env: Env, instructions: string, input: unknown): Promise<LlmResult> {
  const gateway = createGateway({ apiKey: env.VERCEL_AI_GATEWAY_API_KEY });
  try {
    const { output } = await generateText({
      model: gateway(env.LLM_MODEL),
      instructions,
      prompt: `Данные активности за неделю (JSON):\n${JSON.stringify(input)}`,
      reasoning: env.LLM_REASONING_EFFORT,
      output: Output.object({ schema: RESULT_SCHEMA }),
    });
    return output;
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err)) {
      console.error(
        JSON.stringify({
          event: "llm_schema_mismatch",
          provider: "vercel",
          model: env.LLM_MODEL,
          text: err.text,
          cause: String(err.cause),
          finishReason: err.finishReason,
        }),
      );
    }
    throw err;
  }
}

export async function generateInsights(env: Env, week: WeekActivity, state: AppState, newStreak: number): Promise<LlmResult> {
  // Через границу в LLM данные проходят ТОЛЬКО через страж (см. sanitize.ts)
  const input = buildLlmPayload(week, state, newStreak);
  const instructions = systemPrompt(env);

  return env.LLM_PROVIDER === "vercel" ? callVercel(env, instructions, input) : callOpenAI(env, instructions, input);
}
