import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText, type LanguageModelUsage, NoObjectGeneratedError } from "ai";
import { generateInsights } from "../src/llm";
import { makeConfig, makeState, makeWeek } from "./fixtures";

const gen = vi.mocked(generateText);
const env = {} as Env;
const config = makeConfig({ LLM_PROVIDER: "openrouter", LLM_MODEL: "nvidia/nemotron-3-ultra-550b-a55b" });
const answer = { projectSummaries: [], commitMinutes: [], praise: "p", telegramMessage: "t" };
const usage = { inputTokens: 10, outputTokens: 20, outputTokenDetails: { textTokens: 20, reasoningTokens: 0 } } as LanguageModelUsage;

const structured = { output: answer, usage, finishReason: "stop" } as never;
const asText = (text: string) => ({ text, usage, finishReason: "stop" }) as never;

// Which endpoints OpenRouter was allowed to route to on each attempt.
function providerOptions() {
  return gen.mock.calls.map(([args]) => (args.model as unknown as { settings: { provider: Record<string, unknown> } }).settings.provider);
}

function events() {
  return err.mock.calls.map(([line]) => JSON.parse(String(line)));
}

let err: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  gen.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  err = vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("openrouter endpoint fallback", () => {
  it("asks for structured output first, and only that, when the answer arrives", async () => {
    gen.mockResolvedValueOnce(structured);

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).resolves.toEqual(answer);
    expect(providerOptions()).toEqual([{ zdr: true, data_collection: "deny", require_parameters: true }]);
    expect(gen.mock.calls[0][0].output).toBeDefined();
  });

  // The failure of 2026-09-18: the single ZDR endpoint with structured output was rate-limited
  // upstream, and a request carrying response_format is routed nowhere else — so the retry has
  // to drop the structured output, not just `require_parameters`.
  it("retries as plain text when no structured-output endpoint can serve the request", async () => {
    gen.mockRejectedValueOnce(new Error("[DeepInfra] is temporarily rate-limited upstream")).mockResolvedValueOnce(asText(JSON.stringify(answer)));

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).resolves.toEqual(answer);
    expect(providerOptions()).toEqual([
      { zdr: true, data_collection: "deny", require_parameters: true },
      { zdr: true, data_collection: "deny", require_parameters: false },
    ]);
    expect(gen.mock.calls[1][0].output).toBeUndefined();
    expect(events()).toMatchObject([{ event: "llm_strict_endpoint_failed", model: "nvidia/nemotron-3-ultra-550b-a55b" }]);
  });

  it("keeps zero data retention on the fallback attempt and spells the schema out in the instructions", async () => {
    gen.mockRejectedValueOnce(new Error("upstream down")).mockResolvedValueOnce(asText(JSON.stringify(answer)));

    await generateInsights(env, config, makeWeek(), makeState(), 1, []);

    const [strict, fallback] = gen.mock.calls.map(([args]) => String(args.instructions));
    expect(strict).not.toContain("JSON Schema");
    expect(fallback.startsWith(strict)).toBe(true);
    expect(fallback).toContain("telegramMessage");
    expect(providerOptions()[1]).toMatchObject({ zdr: true, data_collection: "deny" });
  });

  it("unwraps and reshapes what a fallback endpoint answers", async () => {
    gen.mockRejectedValueOnce(new Error("upstream down")).mockResolvedValueOnce(
      asText('Here you go:\n```json\n{"projectSummaries":{"a/b":"did things"},"commitMinutes":[],"praise":"p","telegramMessage":"t"}\n```'),
    );

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).resolves.toEqual({
      ...answer,
      projectSummaries: [{ repo: "a/b", summary: "did things" }],
    });
  });

  it("reports the shape, not the content, when the fallback answer is unusable", async () => {
    gen.mockRejectedValueOnce(new Error("upstream down")).mockResolvedValueOnce(asText("I could not do that, sorry."));

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).rejects.toThrow(/did not match schema/);
    expect(events().at(-1)).toMatchObject({ event: "llm_schema_mismatch", provider: "openrouter", output: { kind: "non-json" } });
  });

  // S0. The answer IS the report — private project names and all — so no part of it may reach the
  // logs, whichever way it turns out unusable. SECURITY.md promises the logs hold the shape of the
  // answer and not its content; the canary below is what that promise means in practice.
  describe("nothing of the answer reaches the logs", () => {
    const canary = "ACME-CANARY-PROJECT";
    const logged = () => err.mock.calls.map(([line]) => String(line)).join("\n");

    it("keeps the raw text and the wrapped cause out of the log when the strict attempt misses", async () => {
      gen
        .mockRejectedValueOnce(
          new NoObjectGeneratedError({
            message: "no object",
            cause: new TypeError(`Type validation failed: Value: {"praise":"${canary}"}`),
            text: `Here is the week on ${canary}.`,
            response: { id: "r", timestamp: new Date(0), modelId: "m" },
            usage,
            finishReason: "stop",
          }),
        )
        .mockResolvedValueOnce(asText(JSON.stringify(answer)));

      await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).resolves.toEqual(answer);
      expect(logged()).not.toContain(canary);
      expect(events()).toMatchObject([
        { event: "llm_schema_mismatch", cause: "TypeError", output: { kind: "non-json" } },
        { event: "llm_strict_endpoint_failed", error: "TypeError" },
      ]);
    });

    it("keeps unusable prose out of the log", async () => {
      gen.mockRejectedValueOnce(new Error("upstream down")).mockResolvedValueOnce(asText(`I cannot help with ${canary}.`));

      await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).rejects.toThrow(/did not match schema/);
      expect(logged()).not.toContain(canary);
      expect(events().at(-1)).toMatchObject({ output: { kind: "non-json", fenced: false, startsWithBrace: false } });
    });

    // The weekly one: the model answers with projectSummaries keyed by repository name. Recovery
    // handles that shape, but when the rest of the answer is still wrong the log used to print
    // those keys verbatim.
    it("counts the keys the model invented instead of naming them", async () => {
      gen
        .mockRejectedValueOnce(new Error("upstream down"))
        .mockResolvedValueOnce(asText(JSON.stringify({ projectSummaries: { [`me/${canary}`]: "did things" }, commitMinutes: "not an array" })));

      await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).rejects.toThrow(/did not match schema/);
      expect(logged()).not.toContain(canary);
      expect(events().at(-1)).toMatchObject({ output: { kind: "json", structure: { projectSummaries: { inventedKeys: 1 } } } });
      const issues = events().at(-1).error as Record<string, unknown>[];
      expect(issues.length).toBeGreaterThan(0);
      expect(issues.every((issue) => Object.keys(issue).sort().join() === "code,path")).toBe(true);
    });
  });

  it("does not retry when the structured attempt answered and the answer was recoverable", async () => {
    gen.mockRejectedValueOnce(
      new NoObjectGeneratedError({
        message: "no object",
        text: '{"projectSummaries":{"a/b":"did things"},"commitMinutes":[],"praise":"p","telegramMessage":"t"}',
        response: { id: "r", timestamp: new Date(0), modelId: "m" },
        usage,
        finishReason: "stop",
      }),
    );

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).resolves.toEqual({
      ...answer,
      projectSummaries: [{ repo: "a/b", summary: "did things" }],
    });
    expect(gen).toHaveBeenCalledTimes(1);
  });
});
