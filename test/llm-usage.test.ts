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

const usage = {
  inputTokens: 12_000,
  outputTokens: 9_500,
  outputTokenDetails: { textTokens: 1_500, reasoningTokens: 8_000 },
} as LanguageModelUsage;

let log: ReturnType<typeof vi.spyOn>;

function usageEvents() {
  return log.mock.calls.map(([line]) => JSON.parse(String(line))).filter((e) => e.event === "llm_usage");
}

beforeEach(() => {
  gen.mockReset();
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("llm usage log", () => {
  it("logs token counts and the serving endpoint, without content", async () => {
    gen.mockResolvedValueOnce({
      output: answer,
      usage,
      finishReason: "stop",
      providerMetadata: { openrouter: { provider: "DeepInfra" } },
    } as never);

    await generateInsights(env, config, makeWeek(), makeState(), 1, []);

    expect(usageEvents()).toEqual([
      {
        event: "llm_usage",
        provider: "openrouter",
        model: "nvidia/nemotron-3-ultra-550b-a55b",
        endpoint: "DeepInfra",
        finishReason: "stop",
        inputTokens: 12_000,
        outputTokens: 9_500,
        reasoningTokens: 8_000,
      },
    ]);
  });

  it("logs usage of a truncated answer before rethrowing", async () => {
    const err = new NoObjectGeneratedError({
      message: "no object",
      text: '{"projectSummaries": [',
      response: { id: "r", timestamp: new Date(0), modelId: "m" },
      usage,
      finishReason: "length",
    });
    gen.mockRejectedValueOnce(err);

    await expect(generateInsights(env, config, makeWeek(), makeState(), 1, [])).rejects.toBe(err);
    expect(usageEvents()).toMatchObject([{ finishReason: "length", reasoningTokens: 8_000 }]);
  });
});
