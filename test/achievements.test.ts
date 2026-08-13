import { describe, expect, it } from "vitest";
import { detectAchievements } from "../src/achievements";
import { makeCommit, makeConfig, makePr, makeRepo, makeState, makeWeek } from "./fixtures";

const config = makeConfig();
const ids = (week = makeWeek(), state = makeState(), streak = 1) =>
  detectAchievements(config, week, state, streak).map((a) => a.id);

describe("detectAchievements", () => {
  it("always unlocks first-report on the very first run", () => {
    expect(ids()).toContain("first-report");
  });

  it("does not re-unlock what is already in state", () => {
    expect(ids(makeWeek(), makeState({ unlocked: ["first-report"] }))).not.toContain("first-report");
  });

  it("unlocks commit-count tiers", () => {
    const many = makeWeek({ repos: [makeRepo({ commits: Array.from({ length: 25 }, () => makeCommit()) })] });
    expect(ids(many)).toEqual(expect.arrayContaining(["marathon", "sprinter"]));
  });

  it("unlocks shipper only for a merged pull request", () => {
    expect(ids(makeWeek({ prs: [makePr({ state: "open" })] }))).not.toContain("shipper");
    expect(ids(makeWeek({ prs: [makePr({ state: "merged" })] }))).toContain("shipper");
  });

  it("evaluates night-owl in the configured time zone", () => {
    // 02:30 UTC is 04:30 in Berlin (summer) — still before 6am
    const night = makeWeek({ repos: [makeRepo({ commits: [makeCommit({ date: "2026-08-05T02:30:00Z" })] })] });
    expect(ids(night)).toContain("night-owl");

    // 07:00 UTC is 09:00 in Berlin — not a night commit, though it would be in UTC-4
    const morning = makeWeek({ repos: [makeRepo({ commits: [makeCommit({ date: "2026-08-05T07:00:00Z" })] })] });
    expect(ids(morning)).not.toContain("night-owl");
  });

  it("counts all-time commits toward century", () => {
    expect(ids(makeWeek(), makeState({ allTime: { ...makeState().allTime, commits: 99 } }))).toContain("century");
    expect(ids(makeWeek(), makeState({ allTime: { ...makeState().allTime, commits: 50 } }))).not.toContain("century");
  });

  it("requires a clean CI record for green-week", () => {
    const green = makeWeek({ repos: [makeRepo({ ciSuccess: 5, ciFailure: 0 })] });
    const red = makeWeek({ repos: [makeRepo({ ciSuccess: 5, ciFailure: 1 })] });
    expect(ids(green)).toContain("green-week");
    expect(ids(red)).not.toContain("green-week");
  });

  it("localizes titles through the i18n bundle", () => {
    const [first] = detectAchievements(makeConfig({ REPORT_LANG: "ru" }), makeWeek(), makeState(), 1);
    expect(first.title).toBe("Начало положено");
  });
});
