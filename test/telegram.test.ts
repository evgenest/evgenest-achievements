import { afterEach, describe, expect, it, vi } from "vitest";
import { clipLlmMessage, MAX_LLM_MESSAGE, notifyTelegram } from "../src/telegram";
import { makeConfig } from "./fixtures";

const env = { TELEGRAM_BOT_TOKEN: "token", TELEGRAM_CHAT_ID: "42" } as unknown as Env;
const reportUrl = "https://github.com/octocat/reports/blob/main/reports/2026-08-07.md";

describe("clipLlmMessage", () => {
  it("leaves a message within the limit untouched, markup included", () => {
    const text = "Hi! <b>3 projects</b> this week.";
    expect(clipLlmMessage(text)).toBe(text);
  });

  it("drops the markup if that alone brings the message under the limit", () => {
    expect(clipLlmMessage("<b>abcdef</b>", 8)).toBe("abcdef");
  });

  it("cuts an overlong message at a word boundary without leaving broken tags", () => {
    const text = `<b>${"word ".repeat(1000)}</b>`;
    const clipped = clipLlmMessage(text);
    expect(clipped.length).toBeLessThanOrEqual(MAX_LLM_MESSAGE);
    expect(clipped).not.toMatch(/[<>]/);
    expect(clipped.endsWith("word…")).toBe(true);
  });

  it("hard-cuts a message without spaces", () => {
    const clipped = clipLlmMessage("x".repeat(50), 10);
    expect(clipped).toBe(`${"x".repeat(9)}…`);
  });
});

describe("notifyTelegram", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sentTexts = (fetchMock: ReturnType<typeof vi.fn>) =>
    fetchMock.mock.calls.map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { text: string }).text);

  it("appends achievements and the report link to the LLM message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyTelegram(env, makeConfig(), "Hi! <b>3 projects</b>.", [
      { id: "marathon", title: "Marathoner", description: "10+ commits in a week" },
    ], reportUrl);

    expect(sentTexts(fetchMock)).toEqual([
      `Hi! <b>3 projects</b>.\n\nNew achievements: <b>Marathoner</b>\n\n<a href="${reportUrl}">Open the full report</a>`,
    ]);
  });

  it("keeps a runaway LLM answer under Telegram's 4096-character limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await notifyTelegram(env, makeConfig(), "a ".repeat(5000), [], reportUrl);

    const [text] = sentTexts(fetchMock);
    expect(text.length).toBeLessThan(4096);
    expect(text).toContain(reportUrl);
  });
});
