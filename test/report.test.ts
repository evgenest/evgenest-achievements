import { describe, expect, it } from "vitest";
import { computeWeekCost } from "../src/cost";
import { buildReport } from "../src/report";
import type { LlmResult, WeekCost } from "../src/types";
import { makeCommit, makeConfig, makeIssue, makePr, makeRates, makeRepo, makeState, makeWeek } from "./fixtures";

const llm: LlmResult = {
  projectSummaries: [{ repo: "octocat/public-repo", summary: "Shipped the thing." }],
  commitMinutes: [],
  praise: "Solid week.",
  telegramMessage: "Hi!",
};

// 52 000/yr → 1 000/week → × 12.4/40 = 310; freelance 12.4 × 75 = 930
const defaultCost = computeWeekCost(12.4, makeRates());

const render = (configOverrides = {}, weekOverrides = {}, cost: WeekCost | null = defaultCost) =>
  buildReport({
    config: makeConfig(configOverrides),
    week: makeWeek(weekOverrides),
    state: makeState(),
    newStreak: 2,
    achievements: [{ id: "marathon", title: "Marathoner", description: "10+ commits in a week" }],
    llm,
    cost,
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
    expect(render()).toContain("Employed: **~€310** for the week");
    expect(render()).toContain("Freelance: **~€930** for the week");
    expect(render({ CURRENCY: "USD" })).toContain("Employed: **~$310** for the week");
  });

  it("shows the hours computed in code, not a model guess", () => {
    expect(render()).toContain("Estimated focused hours: **~12.4 h**");
  });

  it("shows the rates used, region, fetch date and source links", () => {
    const md = render();
    expect(md).toContain("Rates: ~€52,000 gross/year employed, ~€75/h freelance · Germany · as of Aug 1, 2026.");
    expect(md).toContain("Sources: [Salary site](https://salaries.example/dev)");
  });

  it("says so when the rates are a model estimate without sources", () => {
    const md = render({}, {}, computeWeekCost(12.4, makeRates({ sources: [] })));
    expect(md).toContain("_No sources: web search was unavailable");
    expect(md).not.toContain("Sources:");
  });

  it("renders the cost section in Russian", () => {
    const md = render({ REPORT_LANG: "ru" });
    expect(md).toContain("## Сколько это стоило бы");
    expect(md).toContain("Ставки: ~");
    expect(md).toContain("Источники: [Salary site]");
  });

  it("omits the salary block when the estimate is disabled", () => {
    const md = render({ ENABLE_SALARY_ESTIMATE: "false" }, {}, null);
    expect(md).not.toContain("What this week was worth");
  });

  it("omits the salary block when no rates are known", () => {
    expect(render({}, {}, null)).not.toContain("What this week was worth");
  });

  it("puts no price tag on a week without focused hours", () => {
    expect(render({}, {}, computeWeekCost(0, makeRates()))).not.toContain("What this week was worth");
  });

  it("shows a delta against the previous week", () => {
    const md = buildReport({
      config: makeConfig(),
      week: makeWeek(),
      state: makeState({ lastWeek: { commits: 5, prs: 0, issues: 0, additions: 0, deletions: 0 } }),
      newStreak: 1,
      achievements: [],
      llm,
      cost: null,
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
            commits: [makeCommit({ headline: "", message: "", url: "" })],
          }),
        ],
      },
    );
    expect(md).toContain("### private-project-1");
    expect(md).not.toContain("secret-thing");
    expect(md).not.toContain("<details>");
    expect(md).toContain("Private repository: details hidden");
  });

  it("lists commit headlines only — bodies and descriptions stay out of the report", () => {
    const md = render(
      {},
      {
        repos: [
          makeRepo({
            commits: [makeCommit({ headline: "feat: add retries", message: "feat: add retries\n\nBody line one\nBody line two" })],
          }),
        ],
        prs: [makePr({ body: "PR description text" })],
        issues: [makeIssue({ body: "Issue description text" })],
      },
    );
    expect(md).toMatch(/^- .*feat: add retries \(\+10\/−2\)$/m);
    expect(md).not.toContain("Body line");
    expect(md).not.toContain("description text");
  });

  it("hides redacted pull requests and issues from the listings", () => {
    const md = render(
      {},
      {
        prs: [makePr({ title: "", body: "", repo: "private-project-1", isPrivate: true, redacted: true })],
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
