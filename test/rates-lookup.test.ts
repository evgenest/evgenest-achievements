import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return { ...actual, generateText: vi.fn() };
});

import { generateText } from "ai";
import { lookupMarketRates } from "../src/rates-lookup";
import { makeConfig } from "./fixtures";

const gen = vi.mocked(generateText);
const env = {} as Env;
const PROFILE = "Jane Doe, senior TypeScript developer at Acme Corp in Berlin, earns 90k, jane@example.com";
const config = (overrides: Record<string, string> = {}) => makeConfig({ DEV_PROFILE: PROFILE, ...overrides });

const extracted = {
  role: "Backend developer",
  seniority: "senior",
  stack: ["TypeScript", "Node.js"],
  region: "Berlin, Germany",
  countryCode: "de",
};

const cited = { title: "Developer salaries Berlin", url: "https://jobs.example.de/salaries/dev" };
const hallucinated = { title: "Made up", url: "https://made-up.example/x" };

function searchResult(overrides: Record<string, unknown> = {}, output: Record<string, unknown> = {}) {
  return {
    output: { annualGross: 72_000, freelanceHourly: 85, region: "Berlin, Germany", sources: [cited, hallucinated], ...output },
    sources: [],
    toolCalls: [{ toolName: "web_search", providerExecuted: true }],
    toolResults: [{ toolName: "web_search", output: { results: [{ ...cited, url: `${cited.url}/`, snippet: "…" }] } }],
    ...overrides,
  } as never;
}

type CallOptions = { model?: unknown; prompt?: string; instructions?: string; tools?: Record<string, unknown> };
const call = (i: number) => gen.mock.calls[i][0] as unknown as CallOptions;

beforeEach(() => {
  gen.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("lookupMarketRates", () => {
  it("shows the profile text only to the tool-less extraction call", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(searchResult());
    await lookupMarketRates(env, config());

    expect(call(0).prompt).toContain(PROFILE);
    expect(call(0).tools).toBeUndefined();

    const search = `${call(1).instructions}\n${call(1).prompt}`;
    for (const personal of ["Jane", "Acme", "90k", "jane@example.com"]) expect(search).not.toContain(personal);
    expect(call(1).prompt).toContain('"role":"Backend developer"');
    expect(call(1).prompt).toContain('"countryCode":"DE"');
  });

  it("uses OpenAI's web search tool with LLM_PROVIDER=openai", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(searchResult());
    await lookupMarketRates(env, config({ LLM_PROVIDER: "openai" }));
    expect(Object.keys(call(1).tools ?? {})).toEqual(["web_search"]);
  });

  it("uses the Gateway's Perplexity search with LLM_PROVIDER=vercel", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(
      searchResult({ toolCalls: [{ toolName: "perplexity_search", providerExecuted: true }] }),
    );
    await lookupMarketRates(env, config({ LLM_PROVIDER: "vercel", LLM_MODEL: "openai/test-model" }));
    expect(Object.keys(call(1).tools ?? {})).toEqual(["perplexity_search"]);
  });

  it("uses OpenRouter's web search and ZDR-only endpoints with LLM_PROVIDER=openrouter", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(searchResult());
    await lookupMarketRates(env, config({ LLM_PROVIDER: "openrouter", LLM_MODEL: "vendor/test-model" }));
    expect(Object.keys(call(1).tools ?? {})).toEqual(["web_search"]);
    expect(call(1).tools?.web_search).toMatchObject({ id: "openrouter.web_search" });
    // Both calls, including the one that sees DEV_PROFILE, go to ZDR endpoints only.
    for (const i of [0, 1]) {
      expect(call(i).model).toMatchObject({ settings: { provider: { zdr: true, data_collection: "deny" } } });
    }
  });

  it("keeps only cited sources the search actually returned", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(searchResult());
    const rates = await lookupMarketRates(env, config());
    expect(rates).toEqual({
      annualGross: 72_000,
      freelanceHourly: 85,
      region: "Berlin, Germany",
      sources: [cited],
    });
  });

  it("lists the search results when the model cites none of them", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(searchResult({}, { sources: [hallucinated] }));
    const rates = await lookupMarketRates(env, config());
    expect(rates.sources.map((s) => s.title)).toEqual([cited.title]);
  });

  it("drops non-http links and strips markdown from titles", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(
      searchResult(
        { toolResults: [], sources: [], toolCalls: [{ toolName: "web_search" }] },
        { sources: [{ title: "x", url: "javascript:alert(1)" }, { title: "[Pay](evil) *guide*", url: "https://pay.example/(a)" }] },
      ),
    );
    const rates = await lookupMarketRates(env, config());
    expect(rates.sources).toEqual([{ title: "Pay evil guide", url: "https://pay.example/%28a%29" }]);
  });

  it("treats an answer without any search as model knowledge (no sources)", async () => {
    gen.mockResolvedValueOnce({ output: extracted } as never).mockResolvedValueOnce(
      searchResult({ toolCalls: [], toolResults: [], sources: [] }),
    );
    expect((await lookupMarketRates(env, config())).sources).toEqual([]);
  });

  it("retries without tools when the search call fails", async () => {
    gen
      .mockResolvedValueOnce({ output: extracted } as never)
      .mockRejectedValueOnce(new Error("tool not supported by this model"))
      .mockResolvedValueOnce({ output: { annualGross: 65_000, freelanceHourly: 70, region: "Germany" } } as never);
    const rates = await lookupMarketRates(env, config());

    expect(call(2).tools).toBeUndefined();
    expect(call(2).instructions).toContain("Web search is not available");
    expect(rates).toEqual({ annualGross: 65_000, freelanceHourly: 70, region: "Germany", sources: [] });
  });

  it("falls back when the search returns unusable amounts", async () => {
    gen
      .mockResolvedValueOnce({ output: extracted } as never)
      .mockResolvedValueOnce(searchResult({}, { annualGross: 0 }))
      .mockResolvedValueOnce({ output: { annualGross: 65_000, freelanceHourly: 70, region: "" } } as never);
    const rates = await lookupMarketRates(env, config());
    expect(rates).toMatchObject({ annualGross: 65_000, region: "Berlin, Germany", sources: [] });
  });

  it("throws when every attempt fails, leaving the fallback to resolveRates", async () => {
    gen.mockRejectedValue(new Error("provider down"));
    await expect(lookupMarketRates(env, config())).rejects.toThrow("provider down");
  });
});
