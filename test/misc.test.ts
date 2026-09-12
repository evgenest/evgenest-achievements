import { describe, expect, it } from "vitest";
import { toBase64 } from "../src/github";
import { normalizeCommitMinutes, normalizeLlmAnswer, normalizeProjectSummaries } from "../src/llm";
import { hourInZone, zonedTimeToUtc } from "../src/time";

describe("zonedTimeToUtc", () => {
  it("honours DST: summer time in Berlin is UTC+2", () => {
    expect(zonedTimeToUtc("2026-08-07", "09:00:00", "Europe/Berlin").toISOString()).toBe("2026-08-07T07:00:00.000Z");
  });

  it("honours DST: winter time in Berlin is UTC+1", () => {
    expect(zonedTimeToUtc("2026-01-09", "09:00:00", "Europe/Berlin").toISOString()).toBe("2026-01-09T08:00:00.000Z");
  });

  it("is identity for UTC", () => {
    expect(zonedTimeToUtc("2026-01-09", "09:00:00", "UTC").toISOString()).toBe("2026-01-09T09:00:00.000Z");
  });

  it("returns an invalid date for garbage input", () => {
    expect(Number.isNaN(zonedTimeToUtc("not-a-date", "09:00:00", "UTC").getTime())).toBe(true);
  });
});

describe("hourInZone", () => {
  it("maps midnight UTC to the local hour", () => {
    expect(hourInZone("2026-08-05T00:30:00Z", "Europe/Berlin")).toBe(2);
    expect(hourInZone("2026-08-05T00:30:00Z", "UTC")).toBe(0);
  });
});

describe("toBase64", () => {
  it("round-trips UTF-8 text", () => {
    const text = "# Отчёт — week #1\n";
    expect(new TextDecoder().decode(Uint8Array.from(atob(toBase64(text)), (c) => c.charCodeAt(0)))).toBe(text);
  });

  it("handles reports far beyond the argument-count limit of fromCharCode", () => {
    const big = "a".repeat(500_000);
    expect(() => toBase64(big)).not.toThrow();
    expect(atob(toBase64(big))).toHaveLength(500_000);
  });
});

describe("normalizeProjectSummaries", () => {
  it("reshapes a dictionary answer into the expected array", () => {
    const raw = { projectSummaries: { "octocat/repo": "Did things." }, praise: "ok" };
    expect(normalizeProjectSummaries(raw)).toEqual({
      projectSummaries: [{ repo: "octocat/repo", summary: "Did things." }],
      praise: "ok",
    });
  });

  it("leaves a correct array answer untouched", () => {
    const raw = { projectSummaries: [{ repo: "a", summary: "b" }] };
    expect(normalizeProjectSummaries(raw)).toEqual(raw);
  });

  it("passes through non-objects", () => {
    expect(normalizeProjectSummaries("nope")).toBe("nope");
    expect(normalizeProjectSummaries(null)).toBe(null);
  });
});

describe("normalizeCommitMinutes", () => {
  it("leaves a correct answer untouched", () => {
    const raw = { commitMinutes: [{ id: 0, minutes: 30 }] };
    expect(normalizeCommitMinutes(raw)).toEqual(raw);
  });

  it("reshapes a dictionary keyed by id", () => {
    expect(normalizeCommitMinutes({ commitMinutes: { "0": 30, "1": "15" } })).toEqual({
      commitMinutes: [
        { id: 0, minutes: 30 },
        { id: 1, minutes: 15 },
      ],
    });
  });

  it("reads a bare array of numbers by position", () => {
    expect(normalizeCommitMinutes({ commitMinutes: [30, 15] })).toEqual({
      commitMinutes: [
        { id: 0, minutes: 30 },
        { id: 1, minutes: 15 },
      ],
    });
  });

  it("drops extra keys and unreadable entries instead of failing the schema", () => {
    expect(
      normalizeCommitMinutes({ commitMinutes: [{ id: 0, minutes: 30, reason: "x" }, { id: "a", minutes: 5 }, null] }),
    ).toEqual({ commitMinutes: [{ id: 0, minutes: 30 }] });
  });

  it("substitutes an empty array when the field is missing", () => {
    expect(normalizeCommitMinutes({ praise: "ok" })).toEqual({ praise: "ok", commitMinutes: [] });
  });

  it("composes with the projectSummaries fix", () => {
    expect(normalizeLlmAnswer({ projectSummaries: { a: "b" }, commitMinutes: { "0": 1 } })).toEqual({
      projectSummaries: [{ repo: "a", summary: "b" }],
      commitMinutes: [{ id: 0, minutes: 1 }],
    });
  });
});
