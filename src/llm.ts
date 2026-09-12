import { createGateway } from "@ai-sdk/gateway";
import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { Config } from "./config";
import type { TimelineCommit } from "./hours";
import { buildLlmPayload } from "./sanitize";
import type { AppState, LlmResult, WeekActivity } from "./types";

// One schema serves both the runtime validation (Vercel/generateText) and the
// JSON Schema handed to the OpenAI Responses API.
const SALARY_SCHEMA = z.strictObject({
  employeeWeek: z.number(),
  freelanceWeek: z.number(),
  rationale: z.string(),
});

const BASE_SHAPE = {
  projectSummaries: z.array(z.strictObject({ repo: z.string(), summary: z.string() })),
  // Per-commit focused minutes; hours are computed from these in code (see hours.ts).
  commitMinutes: z.array(z.strictObject({ id: z.number(), minutes: z.number() })),
  praise: z.string(),
  telegramMessage: z.string(),
};

type ResultSchema = z.ZodType<LlmResult>;

/** The salary block is only requested (and only accepted) when the estimate is enabled. */
function resultSchema(salaryEstimate: boolean): ResultSchema {
  return (
    salaryEstimate ? z.strictObject({ ...BASE_SHAPE, salary: SALARY_SCHEMA }) : z.strictObject(BASE_SHAPE)
  ) as ResultSchema;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// For diagnosing schema mismatches the SHAPE of the answer is enough (which keys,
// of what type, of what length) — the content itself never needs to reach the logs.
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

// If parsing failed the answer is not JSON at all and there is no structure to log;
// only then does the (truncated) raw text get logged, because nothing else helps.
function describeLlmOutput(rawText: string, parsed: unknown): unknown {
  return parsed !== undefined ? { kind: "json", structure: describeStructure(parsed) } : { kind: "non-json", preview: rawText.slice(0, 300) };
}

function jsonSchemaForOpenAI(schema: ResultSchema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

// Some models (especially outside strict structured output, e.g. through the Vercel
// Gateway) return projectSummaries as an object { repoName: summary } instead of an
// array — reshape it before validation rather than loosening the schema.
export function normalizeProjectSummaries(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const ps = obj.projectSummaries;
  if (ps === null || typeof ps !== "object" || Array.isArray(ps)) return raw;
  return {
    ...obj,
    projectSummaries: Object.entries(ps as Record<string, unknown>).map(([repo, summary]) => ({ repo, summary })),
  };
}

function toNumber(value: unknown): number {
  return typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : Number.NaN;
}

// Same idea for commitMinutes: accept { "0": 30 }, [30, 15] or items with extra keys, and
// drop what can't be read — a missing estimate falls back to a heuristic in code, while a
// schema failure would sink the whole report.
export function normalizeCommitMinutes(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const cm = obj.commitMinutes;
  const pairs: [unknown, unknown][] = Array.isArray(cm)
    ? cm.map((item, i) =>
        item !== null && typeof item === "object"
          ? [(item as Record<string, unknown>).id, (item as Record<string, unknown>).minutes]
          : [i, item],
      )
    : cm !== null && typeof cm === "object"
      ? Object.entries(cm as Record<string, unknown>)
      : [];
  const commitMinutes = pairs
    .map(([id, minutes]) => ({ id: toNumber(id), minutes: toNumber(minutes) }))
    .filter((e) => Number.isFinite(e.id) && Number.isFinite(e.minutes));
  return { ...obj, commitMinutes };
}

export function normalizeLlmAnswer(raw: unknown): unknown {
  return normalizeCommitMinutes(normalizeProjectSummaries(raw));
}

function systemPrompt(config: Config): string {
  return config.messages.prompt({
    devProfile: config.devProfile,
    languageName: config.messages.languageName,
    currency: config.currency,
    salaryEstimate: config.salaryEstimate,
  });
}

async function callOpenAI(env: Env, config: Config, schema: ResultSchema, instructions: string, input: unknown): Promise<LlmResult> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.llm.model,
      reasoning: { effort: config.llm.reasoningEffort },
      instructions,
      input: `Weekly activity data (JSON):\n${JSON.stringify(input)}`,
      text: {
        format: {
          type: "json_schema",
          name: "weekly_insights",
          strict: true,
          schema: jsonSchemaForOpenAI(schema),
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
  const result = parsed !== undefined ? schema.safeParse(normalizeLlmAnswer(parsed)) : undefined;
  if (result?.success) return result.data;

  console.error(
    JSON.stringify({
      event: "llm_schema_mismatch",
      provider: "openai",
      model: config.llm.model,
      output: describeLlmOutput(text, parsed),
      error: result ? String(result.error) : "invalid JSON",
    }),
  );
  throw new Error(`OpenAI: response did not match schema (${result ? "validation failed" : "invalid JSON"})`);
}

// Vercel AI Gateway: a single billing and routing point to the same models,
// for when paying the provider directly is inconvenient.
async function callVercel(env: Env, config: Config, schema: ResultSchema, instructions: string, input: unknown): Promise<LlmResult> {
  const gateway = createGateway({ apiKey: env.VERCEL_AI_GATEWAY_API_KEY });
  try {
    const { output } = await generateText({
      model: gateway(config.llm.model),
      instructions,
      prompt: `Weekly activity data (JSON):\n${JSON.stringify(input)}`,
      reasoning: config.llm.reasoningEffort,
      output: Output.object({ schema }),
    });
    return output;
  } catch (err) {
    if (NoObjectGeneratedError.isInstance(err) && err.text) {
      const parsed = safeJsonParse(err.text);
      const recovered = parsed !== undefined ? schema.safeParse(normalizeLlmAnswer(parsed)) : undefined;
      if (recovered?.success) return recovered.data;

      console.error(
        JSON.stringify({
          event: "llm_schema_mismatch",
          provider: "vercel",
          model: config.llm.model,
          output: describeLlmOutput(err.text, parsed),
          cause: String(err.cause),
          finishReason: err.finishReason,
        }),
      );
    }
    throw err;
  }
}

export async function generateInsights(
  env: Env,
  config: Config,
  week: WeekActivity,
  state: AppState,
  newStreak: number,
  timeline: readonly TimelineCommit[],
): Promise<LlmResult> {
  // The only path across the boundary into an LLM goes through the guard (see sanitize.ts)
  const input = buildLlmPayload(week, state, newStreak, timeline);
  const instructions = systemPrompt(config);
  const schema = resultSchema(config.salaryEstimate);

  return config.llm.provider === "vercel"
    ? callVercel(env, config, schema, instructions, input)
    : callOpenAI(env, config, schema, instructions, input);
}
