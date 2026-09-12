import { describe, expect, it } from "vitest";
import { assertSanitized, buildLlmPayload } from "../src/sanitize";
import { makePr, makeRepo, makeState, makeWeek, makeCommit } from "./fixtures";

describe("assertSanitized", () => {
  it("accepts a payload built by buildLlmPayload", () => {
    expect(() => assertSanitized(buildLlmPayload(makeWeek(), makeState(), 1))).not.toThrow();
  });

  it("throws on any key outside the allowlist (fail-closed)", () => {
    expect(() => assertSanitized({ week: { patch: "diff --git a/secret" } })).toThrow(/unexpected key "patch"/);
  });

  it("walks nested arrays and objects", () => {
    expect(() => assertSanitized({ week: { repos: [{ repo: "a", sourceCode: "x" }] } })).toThrow(
      /unexpected key "sourceCode".*repos\[0\]/s,
    );
  });
});

describe("buildLlmPayload", () => {
  it("projects only allowlisted primitives — no urls, no dates of commits", () => {
    const payload = buildLlmPayload(makeWeek(), makeState(), 1);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("https://");
    expect(serialized).not.toContain(makeCommit().date);
    expect(payload.week.repos[0]).not.toHaveProperty("url");
  });

  it("sends one chronological commits array across repos with timing, not timestamps", () => {
    const week = makeWeek({
      repos: [
        makeRepo({ fullName: "octocat/a", commits: [makeCommit({ message: "a2", date: "2026-08-05T11:00:00Z" })] }),
        makeRepo({ fullName: "octocat/b", commits: [makeCommit({ message: "b1", date: "2026-08-05T10:30:00Z" })] }),
      ],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.commits).toEqual([
      { id: 0, repo: "octocat/b", message: "b1", additions: 10, deletions: 2, windowMinutes: 120, startsSession: true },
      { id: 1, repo: "octocat/a", message: "a2", additions: 10, deletions: 2, windowMinutes: 30, startsSession: false },
    ]);
    expect(payload.week.repos[0]).not.toHaveProperty("commitMessages");
    expect(() => assertSanitized(payload)).not.toThrow();
  });

  it("clips long text to 200 characters", () => {
    const long = "x".repeat(500);
    const week = makeWeek({ repos: [makeRepo({ commits: [makeCommit({ message: long })] })] });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.commits[0].message).toHaveLength(201); // 200 + ellipsis
  });

  it("keeps timing and line counters but no text for redacted repos", () => {
    const week = makeWeek({
      repos: [
        makeRepo({
          fullName: "private-project-1",
          displayName: "private-project-1",
          isPrivate: true,
          redacted: true,
          // A message would never survive applyPrivacy; the guard drops it regardless.
          commits: [makeCommit({ message: "feat: acquisition pricing model", additions: 42, deletions: 7 })],
        }),
      ],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.commits[0]).toMatchObject({
      repo: "private-project-1",
      message: "",
      additions: 42,
      deletions: 7,
      startsSession: true,
    });
    expect(JSON.stringify(payload)).not.toContain("acquisition");
  });

  it("sends the display name and drops commit messages for redacted repos", () => {
    const week = makeWeek({
      repos: [
        makeRepo({
          fullName: "octocat/secret-thing",
          displayName: "private-project-1",
          isPrivate: true,
          redacted: true,
          commits: [makeCommit({ message: "" })],
        }),
      ],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.repos[0].repo).toBe("private-project-1");
    expect(payload.week.commits.map((c) => c.message)).toEqual([""]);
    expect(JSON.stringify(payload)).not.toContain("secret-thing");
  });

  it("omits redacted pull requests and issues entirely", () => {
    const week = makeWeek({
      prs: [makePr({ title: "", repo: "private-project-1", isPrivate: true, redacted: true }), makePr()],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.prs).toHaveLength(1);
    expect(payload.week.prs[0].title).toBe("Add feature");
  });

  it("carries streak context without touching state internals", () => {
    const state = makeState({ reportCount: 4, bestStreak: 3 });
    const payload = buildLlmPayload(makeWeek(), state, 7);
    expect(payload.context).toMatchObject({ weekNumber: 5, streakWeeks: 7, bestStreak: 3 });
  });
});
