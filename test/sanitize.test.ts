import { describe, expect, it } from "vitest";
import { applyPrivacy } from "../src/privacy";
import { assertSanitized, buildLlmPayload } from "../src/sanitize";
import { makeCommit, makeIssue, makePr, makeRepo, makeState, makeWeek } from "./fixtures";

const token = () => ["gh", "p_", "Zx9Qm2Lp7Rt4Vb8Nc1Kd6Hs3Jf5Gw0Ty", "abcd"].join("");

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

  it("sends the full commit message — headline and body", () => {
    const payload = buildLlmPayload(makeWeek(), makeState(), 1);
    expect(payload.week.commits[0].message).toBe("feat: something\n\nAdds the thing behind a feature flag.");
  });

  it("sends PR and issue descriptions next to their titles", () => {
    const payload = buildLlmPayload(makeWeek(), makeState(), 1);
    expect(payload.week.prs[0]).toEqual({
      repo: "octocat/public-repo",
      title: "Add feature",
      body: "Implements the feature and covers it with tests.",
      state: "merged",
    });
    expect(payload.week.issues[0].body).toBe("Steps to reproduce: open the page twice.");
  });

  it("drops HTML comments (PR templates) from descriptions", () => {
    const week = makeWeek({ prs: [makePr({ body: "<!-- Describe your change -->\nAdds retries.\n<!--\nchecklist\n-->" })] });
    expect(buildLlmPayload(week, makeState(), 1).week.prs[0].body).toBe("Adds retries.");
  });

  it("clips long text to 1000 characters", () => {
    const long = "x ".repeat(1000);
    const week = makeWeek({
      repos: [makeRepo({ commits: [makeCommit({ message: long })] })],
      prs: [makePr({ body: long })],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    expect(payload.week.commits[0].message).toHaveLength(1001); // 1000 + ellipsis
    expect(payload.week.prs[0].body).toHaveLength(1001);
  });

  it("scrubs secrets from commit messages, titles and descriptions", () => {
    const week = makeWeek({
      repos: [makeRepo({ commits: [makeCommit({ message: `fix: rotate key\n\nold one was ${token()}` })] })],
      prs: [makePr({ title: `Remove ${token()}`, body: `Token ${token()} leaked in CI logs` })],
      issues: [makeIssue({ title: "Leak", body: `found ${token()}` })],
    });
    const payload = buildLlmPayload(week, makeState(), 1);
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(token());
    expect(payload.week.commits[0].message).toBe("fix: rotate key\n\nold one was [secret]");
    expect(payload.week.prs[0]).toMatchObject({ title: "Remove [secret]", body: "Token [secret] leaked in CI logs" });
    expect(payload.week.issues[0].body).toBe("found [secret]");
  });

  it("scrubs before clipping — a secret straddling the cut does not leak half-way", () => {
    // The token spans characters 981–1021, across the 1000-character cut.
    const message = `${"x".repeat(980)} ${token()} tail`;
    const week = makeWeek({ repos: [makeRepo({ commits: [makeCommit({ message })] })] });
    const clipped = buildLlmPayload(week, makeState(), 1).week.commits[0].message;
    expect(clipped).not.toContain("gh" + "p_");
    expect(clipped.endsWith("[secret] tail")).toBe(true);
  });

  it("blocks the LLM call when a secret-like string survives in any field (fail-closed)", () => {
    // Repository names are not scrubbed (reports match summaries by name) — only re-checked.
    const week = makeWeek({ repos: [makeRepo({ displayName: `octocat/${token()}` })] });
    expect(() => buildLlmPayload(week, makeState(), 1)).toThrow(/secret-like text \(github-token\) at \$\.week\.repos\[0\]\.repo/);
  });

  it("sends the display name and drops commit messages for redacted repos", () => {
    const week = makeWeek({
      repos: [
        makeRepo({
          fullName: "octocat/secret-thing",
          displayName: "private-project-1",
          isPrivate: true,
          redacted: true,
          commits: [makeCommit({ headline: "", message: "" })],
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
      prs: [makePr({ title: "", body: "", repo: "private-project-1", isPrivate: true, redacted: true }), makePr()],
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

describe("privacy policy → LLM payload, end to end", () => {
  const MARKERS = ["PRIVATE-HEADLINE", "PRIVATE-COMMIT-BODY", "PRIVATE-PR-TITLE", "PRIVATE-PR-BODY", "PRIVATE-ISSUE-TITLE", "PRIVATE-ISSUE-BODY"];
  const week = () =>
    makeWeek({
      repos: [
        makeRepo(),
        makeRepo({
          fullName: "octocat/secret-thing",
          isPrivate: true,
          commits: [makeCommit({ headline: "PRIVATE-HEADLINE", message: "PRIVATE-HEADLINE\n\nPRIVATE-COMMIT-BODY" })],
        }),
      ],
      prs: [makePr(), makePr({ repo: "octocat/secret-thing", isPrivate: true, title: "PRIVATE-PR-TITLE", body: "PRIVATE-PR-BODY" })],
      issues: [
        makeIssue({ repo: "octocat/secret-thing", isPrivate: true, title: "PRIVATE-ISSUE-TITLE", body: "PRIVATE-ISSUE-BODY" }),
      ],
    });
  const serialize = (mode: "full" | "redact" | "skip") =>
    JSON.stringify(buildLlmPayload(applyPrivacy(week(), mode), makeState(), 1));

  it("full: private commit bodies and PR/issue descriptions do reach the payload (control)", () => {
    const serialized = serialize("full");
    for (const marker of MARKERS.filter((m) => m !== "PRIVATE-HEADLINE")) expect(serialized).toContain(marker);
  });

  it.each(["redact", "skip"] as const)("%s: no private text — message, title or description — reaches the payload", (mode) => {
    const serialized = serialize(mode);
    for (const marker of MARKERS) expect(serialized).not.toContain(marker);
    expect(serialized).not.toContain("secret-thing");
    // Public activity keeps its extended text.
    expect(serialized).toContain("Adds the thing behind a feature flag.");
    expect(serialized).toContain("Implements the feature and covers it with tests.");
  });
});
