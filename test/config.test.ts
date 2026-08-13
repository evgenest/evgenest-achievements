import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { makeConfig } from "./fixtures";

describe("loadConfig", () => {
  it("falls back to safe defaults when vars are missing", () => {
    const config = loadConfig({} as unknown as Env);
    expect(config).toMatchObject({
      lang: "en",
      timezone: "UTC",
      currency: "EUR",
      reportsDir: "reports",
      privacy: "redact", // privacy-preserving by default
      salaryEstimate: false, // off unless explicitly enabled
      maxRepos: 15,
    });
    expect(config.llm.provider).toBe("openai");
  });

  it("keeps an unknown language from breaking the run", () => {
    expect(loadConfig({ REPORT_LANG: "kl" } as unknown as Env).lang).toBe("en");
  });

  it("parses booleans and integers leniently", () => {
    expect(makeConfig({ ENABLE_SALARY_ESTIMATE: "1" }).salaryEstimate).toBe(true);
    expect(makeConfig({ ENABLE_SALARY_ESTIMATE: "nonsense" }).salaryEstimate).toBe(false);
    expect(makeConfig({ MAX_REPOS: "0" }).maxRepos).toBe(15);
    expect(makeConfig({ MAX_REPOS: "40" }).maxRepos).toBe(40);
  });

  it("rejects an unknown privacy mode instead of silently exposing data", () => {
    expect(makeConfig({ PRIVATE_REPOS: "everything" }).privacy).toBe("redact");
    expect(makeConfig({ PRIVATE_REPOS: "skip" }).privacy).toBe("skip");
  });

  it("normalizes the reports directory", () => {
    expect(makeConfig({ REPORTS_DIR: "/weekly/" }).reportsDir).toBe("weekly");
  });

  it("only accepts vercel as an alternative provider", () => {
    expect(makeConfig({ LLM_PROVIDER: "vercel" }).llm.provider).toBe("vercel");
    expect(makeConfig({ LLM_PROVIDER: "anything-else" }).llm.provider).toBe("openai");
  });
});
