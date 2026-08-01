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

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Для диагностики схемных мисматчей достаточно ФОРМЫ ответа (какие ключи, какого типа,
// какой длины), без самого контента — раскрытие бизнес-контекста в логах не нужно.
function describeStructure(value: unknown): unknown {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return { array: value.length, item: value.length > 0 ? describeStructure(value[0]) : undefined };
  }
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, describeStructure(v)]));
  }
  if (typeof value === "string") return `string(${value.length})`;
  return typeof value;
}

// Если распарсить не удалось — не JSON вовсе, структуру не построить, в этом случае
// логируем обрезанный текст (только тут контент реально нужен для диагностики).
function describeLlmOutput(rawText: string, parsed: unknown): unknown {
  return parsed !== undefined ? { kind: "json", structure: describeStructure(parsed) } : { kind: "non-json", preview: rawText.slice(0, 300) };
}

function jsonSchemaForOpenAI() {
  const { $schema, ...schema } = z.toJSONSchema(RESULT_SCHEMA);
  return schema;
}

// Некоторые модели (особенно вне строгого structured output, напр. через Vercel Gateway)
// иногда отдают projectSummaries как объект { repoName: summary } вместо массива —
// приводим к ожидаемой форме перед валидацией, не ослабляя саму схему.
function normalizeProjectSummaries(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const ps = obj.projectSummaries;
  if (ps === null || typeof ps !== "object" || Array.isArray(ps)) return raw;
  return {
    ...obj,
    projectSummaries: Object.entries(ps as Record<string, unknown>).map(([repo, summary]) => ({ repo, summary })),
  };
}

function systemPrompt(env: Env): string {
  return `Ты — опытный tech lead и тёплый, но честный карьерный коуч. Твоя задача — помочь разработчику увидеть и оценить реальные результаты его недели. Он склонен обесценивать свою работу, поэтому подчёркивай достижения, но только по фактам — без пустой лести и сиропа.

Профиль разработчика: ${env.DEV_PROFILE}

Отвечай на языке: ${env.REPORT_LANG === "ru" ? "русский" : "английский"}.

Правила:
- projectSummaries: МАССИВ объектов вида {"repo": "...", "summary": "..."} — по одному объекту на каждый репозиторий из данных. НЕ объект/словарь с именами репозиториев в качестве ключей. Поле repo — полное имя репозитория как в данных. Поле summary — 2-5 предложений человеческим языком о том, что было сделано ПО СУТИ (бизнес-логика, ценность), а не пересказ сообщений коммитов.
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
  const parsed = safeJsonParse(text);
  const result = parsed !== undefined ? RESULT_SCHEMA.safeParse(normalizeProjectSummaries(parsed)) : undefined;
  if (result?.success) return result.data;

  console.error(
    JSON.stringify({
      event: "llm_schema_mismatch",
      provider: "openai",
      model: env.LLM_MODEL,
      output: describeLlmOutput(text, parsed),
      error: result ? String(result.error) : "invalid JSON",
    }),
  );
  throw new Error(`OpenAI: response did not match schema (${result ? "validation failed" : "invalid JSON"})`);
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
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      const parsed = safeJsonParse(err.text);
      const recovered = parsed !== undefined ? RESULT_SCHEMA.safeParse(normalizeProjectSummaries(parsed)) : undefined;
      if (recovered?.success) return recovered.data;

      console.error(
        JSON.stringify({
          event: "llm_schema_mismatch",
          provider: "vercel",
          model: env.LLM_MODEL,
          output: describeLlmOutput(err.text, parsed),
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
