import { createGateway } from "@ai-sdk/gateway";
import { type FinishReason, generateText, type LanguageModelUsage, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";
import type { Config, LlmProvider } from "./config";
import type { TimelineCommit } from "./hours";
import { openRouterZdr } from "./openrouter";
import { buildLlmPayload } from "./sanitize";
import type { AppState, LlmResult, WeekActivity } from "./types";

// One schema serves both the runtime validation (Vercel/generateText) and the
// JSON Schema handed to the OpenAI Responses API. Hours and money are not asked for:
// both are computed in code (hours.ts, rates.ts, cost.ts).
const RESULT_SHAPE = {
  projectSummaries: z.array(z.strictObject({ repo: z.string(), summary: z.string() })),
  // Per-commit focused minutes; hours are computed from these in code (see hours.ts).
  commitMinutes: z.array(z.strictObject({ id: z.number(), minutes: z.number() })),
  praise: z.string(),
  telegramMessage: z.string(),
};

type ResultSchema = z.ZodType<LlmResult>;

const RESULT_SCHEMA = z.strictObject(RESULT_SHAPE) as ResultSchema;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Endpoints without strict structured output (the fallback route, see callOpenRouter) tend to wrap
// the object in a markdown fence or bracket it with a sentence — unwrap before giving up on it.
function safeJsonParse(text: string): unknown {
  const direct = parseJson(text.trim());
  if (direct !== undefined) return direct;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return candidate ? parseJson(candidate.trim()) : undefined;
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

function raise(err: unknown): never {
  throw err;
}

function activityPrompt(input: unknown): string {
  return `Weekly activity data (JSON):\n${JSON.stringify(input)}`;
}

function systemPrompt(config: Config): string {
  return config.messages.prompt({
    devProfile: config.devProfile,
    languageName: config.messages.languageName,
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
      input: activityPrompt(input),
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

// Token counts only, no content: reasoning counts toward the endpoint's output cap, so this
// shows how much headroom an answer had before a truncated one sinks the report.
function logUsage(
  provider: LlmProvider,
  config: Config,
  run: { usage: LanguageModelUsage | undefined; finishReason: FinishReason | undefined; endpoint?: unknown },
): void {
  console.log(
    JSON.stringify({
      event: "llm_usage",
      provider,
      model: config.llm.model,
      endpoint: run.endpoint,
      finishReason: run.finishReason,
      inputTokens: run.usage?.inputTokens,
      outputTokens: run.usage?.outputTokens,
      reasoningTokens: run.usage?.outputTokenDetails.reasoningTokens,
    }),
  );
}

// When the SDK rejects the model's structured output, the raw text often still holds a
// valid (or reshapeable) object — recover it before giving up. `undefined` means the answer
// is beyond saving and the caller decides whether to retry or rethrow.
function recoverSchemaMiss(err: unknown, provider: LlmProvider, config: Config, schema: ResultSchema): LlmResult | undefined {
  if (NoObjectGeneratedError.isInstance(err)) logUsage(provider, config, err);
  if (NoObjectGeneratedError.isInstance(err) && err.text) {
    const parsed = safeJsonParse(err.text);
    const recovered = parsed !== undefined ? schema.safeParse(normalizeLlmAnswer(parsed)) : undefined;
    if (recovered?.success) return recovered.data;

    console.error(
      JSON.stringify({
        event: "llm_schema_mismatch",
        provider,
        model: config.llm.model,
        output: describeLlmOutput(err.text, parsed),
        cause: String(err.cause),
        finishReason: err.finishReason,
      }),
    );
  }
  return undefined;
}

// Vercel AI Gateway: a single billing and routing point to the same models,
// for when paying the provider directly is inconvenient.
async function callVercel(env: Env, config: Config, schema: ResultSchema, instructions: string, input: unknown): Promise<LlmResult> {
  const gateway = createGateway({ apiKey: env.VERCEL_AI_GATEWAY_API_KEY });
  try {
    const { output, ...run } = await generateText({
      model: gateway(config.llm.model),
      instructions,
      prompt: activityPrompt(input),
      reasoning: config.llm.reasoningEffort,
      output: Output.object({ schema }),
    });
    logUsage("vercel", config, run);
    return output;
  } catch (err) {
    return recoverSchemaMiss(err, "vercel", config, schema) ?? raise(err);
  }
}

// Without structured output the schema is a request, not a guarantee — so it is spelled out
// in the instructions instead. Only used on the fallback attempt (see callOpenRouter).
function jsonOnlyInstructions(instructions: string, schema: ResultSchema): string {
  return `${instructions}\n\nAnswer with a single JSON object and nothing else — no prose around it, no markdown fences. It must match this JSON Schema:\n${JSON.stringify(jsonSchemaForOpenAI(schema))}`;
}

function openRouterEndpoint(providerMetadata: unknown): unknown {
  return (providerMetadata as { openrouter?: { provider?: unknown } } | undefined)?.openrouter?.provider;
}

// OpenRouter, locked to zero-data-retention endpoints (see openrouter.ts).
async function strictViaOpenRouter(
  env: Env,
  config: Config,
  schema: ResultSchema,
  instructions: string,
  input: unknown,
): Promise<LlmResult> {
  const { model } = openRouterZdr(env, config, { strictStructuredOutput: true });
  const { output, usage, finishReason, providerMetadata } = await generateText({
    model,
    instructions,
    prompt: activityPrompt(input),
    output: Output.object({ schema }),
  });
  // The upstream endpoint that served the request (e.g. DeepInfra): output caps differ per endpoint.
  logUsage("openrouter", config, { usage, finishReason, endpoint: openRouterEndpoint(providerMetadata) });
  return output;
}

/**
 * The fallback attempt, and the reason it asks for plain text: a request carrying
 * `response_format: json_schema` (which `Output.object` adds) is routed by OpenRouter only to
 * endpoints that support structured output — for this model exactly one, verified against the
 * live API on 2026-09-18, and `require_parameters: false` does not widen it. Dropping the
 * structured output is what actually opens the rest of the ZDR pool; the schema moves into the
 * instructions and the answer is validated here.
 */
async function textViaOpenRouter(
  env: Env,
  config: Config,
  schema: ResultSchema,
  instructions: string,
  input: unknown,
): Promise<LlmResult> {
  const { model } = openRouterZdr(env, config, { strictStructuredOutput: false });
  const { text, usage, finishReason, providerMetadata } = await generateText({
    model,
    instructions: jsonOnlyInstructions(instructions, schema),
    prompt: activityPrompt(input),
  });
  logUsage("openrouter", config, { usage, finishReason, endpoint: openRouterEndpoint(providerMetadata) });

  const parsed = safeJsonParse(text);
  const result = parsed !== undefined ? schema.safeParse(normalizeLlmAnswer(parsed)) : undefined;
  if (result?.success) return result.data;

  console.error(
    JSON.stringify({
      event: "llm_schema_mismatch",
      provider: "openrouter",
      model: config.llm.model,
      output: describeLlmOutput(text, parsed),
      error: result ? String(result.error) : "invalid JSON",
    }),
  );
  throw new Error(`OpenRouter: response did not match schema (${result ? "validation failed" : "invalid JSON"})`);
}

/**
 * Two attempts, both ZDR. The first asks for structured output, which for some models leaves
 * exactly one eligible endpoint — an upstream rate limit there sank a whole weekly run on
 * 2026-09-18. The second asks for plain JSON text instead, which is what opens the rest of the
 * ZDR pool (see textViaOpenRouter). Data retention is never traded away — if no ZDR endpoint
 * answers at all, the run fails.
 */
async function callOpenRouter(env: Env, config: Config, schema: ResultSchema, instructions: string, input: unknown): Promise<LlmResult> {
  try {
    return await strictViaOpenRouter(env, config, schema, instructions, input);
  } catch (err) {
    const recovered = recoverSchemaMiss(err, "openrouter", config, schema);
    if (recovered) return recovered;
    console.error(
      JSON.stringify({
        event: "llm_strict_endpoint_failed",
        provider: "openrouter",
        model: config.llm.model,
        error: String(err).slice(0, 300),
      }),
    );
    return textViaOpenRouter(env, config, schema, instructions, input);
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
  const schema = RESULT_SCHEMA;

  switch (config.llm.provider) {
    case "vercel":
      return callVercel(env, config, schema, instructions, input);
    case "openrouter":
      return callOpenRouter(env, config, schema, instructions, input);
    case "openai":
      return callOpenAI(env, config, schema, instructions, input);
  }
}
