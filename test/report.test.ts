import { describe, expect, it } from "vitest";
import { buildReport } from "../src/report";
import type { LlmResult } from "../src/types";
import { makeCommit, makeConfig, makeIssue, makePr, makeRepo, makeState, makeWeek } from "./fixtures";

const llm: LlmResult = {
  projectSummaries: [{ repo: "octocat/public-repo", summary: "Shipped the thing." }],
  hoursEstimate: 12.4,
  salary: { employeeWeek: 1234, freelanceWeek: 2345, rationale: "Rates used: ..." },
  praise: "Solid week.",
  telegramMessage: "Hi!",
};

const render = (configOverrides = {}, weekOverrides = {}, llmOverrides: Partial<LlmResult> = {}) =>
  buildReport({
    config: makeConfig(configOverrides),
    week: makeWeek(weekOverrides),
    state: makeState(),
    newStreak: 2,
    achievements: [{ id: "marathon", title: "Marathoner", description: "10+ commits in a week" }],
    llm: { ...llm, ...llmOverrides },
  });

describe("buildReport", () => {
  it("renders headings, metrics and the coach's note in English", () => {
    const md = render();
    expect(md).toContain("# Weekly Achievements — week #1");
    expect(md).toContain("## Week at a glance");
    expect(md).toContain("Solid week.");
    expect(md).toContain("**Marathoner** — 10+ commits in a week");
  });

  it("renders Russian copy when REPORT_LANG=ru", () => {
    const md = render({ REPORT_LANG: "ru" });
    expect(md).toContain("## Итоги недели");
    expect(md).toContain("неделя #1");
  });

  it("uses the configured currency for the salary block", () => {
    expect(render()).toMatch(/€\s?1[,. ]?234/);
    expect(render({ CURRENCY: "USD" })).toMatch(/\$1[,. ]?234/);
  });

  it("omits the salary block when the estimate is disabled", () => {
    const md = render({ ENABLE_SALARY_ESTIMATE: "false" }, {}, { salary: undefined });
    expect(md).not.toContain("What this week was worth");
  });

  it("shows a delta against the previous week", () => {
    const md = buildReport({
      config: makeConfig(),
      week: makeWeek(),
      state: makeState({ lastWeek: { commits: 5, prs: 0, issues: 0, additions: 0, deletions: 0 } }),
      newStreak: 1,
      achievements: [],
      llm,
    });
    expect(md).toMatch(/\| Commits \| 1 \| -4 \|/);
  });

  it("links public repos and leaves redacted ones unlinked and detail-free", () => {
    const md = render(
      {},
      {
        repos: [
          makeRepo({
            fullName: "octocat/secret-thing",
            displayName: "private-project-1",
            isPrivate: true,
            redacted: true,
            url: "",
            commits: [makeCommit({ message: "", url: "" })],
          }),
        ],
      },
    );
    expect(md).toContain("### private-project-1");
    expect(md).not.toContain("secret-thing");
    expect(md).not.toContain("<details>");
    expect(md).toContain("Private repository: details hidden");
  });

  it("hides redacted pull requests and issues from the listings", () => {
    const md = render(
      {},
      {
        prs: [makePr({ title: "", repo: "private-project-1", isPrivate: true, redacted: true })],
        issues: [makeIssue()],
      },
    );
    expect(md).not.toContain("## Pull requests\n");
    expect(md).toContain("## Issues");
  });

  it("formats dates in the configured time zone", () => {
    // 2026-08-07T23:30Z is already Aug 8 in Berlin
    const md = render({}, { until: "2026-08-07T23:30:00Z" });
    expect(md).toContain("Aug 8, 2026");
  });
});
