import { describe, expect, it } from "vitest";
import { advanceState, isActiveWeek } from "../src/state";
import { makeRepo, makeState, makeWeek } from "./fixtures";

const emptyWeek = () => makeWeek({ repos: [], prs: [], issues: [] });

describe("isActiveWeek", () => {
  it("is active with any commit, pr or issue", () => {
    expect(isActiveWeek(makeWeek())).toBe(true);
    expect(isActiveWeek(makeWeek({ repos: [], prs: [] }))).toBe(true); // issue only
  });

  it("is inactive with nothing at all", () => {
    expect(isActiveWeek(emptyWeek())).toBe(false);
  });
});

describe("advanceState", () => {
  it("does not mutate the input state", () => {
    const state = makeState();
    const snapshot = structuredClone(state);
    advanceState(state, makeWeek(), ["marathon"]);
    expect(state).toEqual(snapshot);
  });

  it("grows the streak on an active week and records the best", () => {
    const next = advanceState(makeState({ streak: 3, bestStreak: 3 }), makeWeek(), []);
    expect(next).toMatchObject({ streak: 4, bestStreak: 4 });
  });

  it("resets the streak on an empty week but keeps the record", () => {
    const next = advanceState(makeState({ streak: 5, bestStreak: 5 }), emptyWeek(), []);
    expect(next).toMatchObject({ streak: 0, bestStreak: 5 });
  });

  it("accumulates all-time totals and counts active weeks", () => {
    const week = makeWeek({ repos: [makeRepo({ additions: 100, deletions: 40 })] });
    const next = advanceState(makeState(), week, []);
    expect(next.allTime).toMatchObject({ commits: 1, prs: 1, issues: 1, additions: 100, deletions: 40, activeWeeks: 1 });
  });

  it("does not count an empty week as active", () => {
    expect(advanceState(makeState(), emptyWeek(), []).allTime.activeWeeks).toBe(0);
  });

  it("appends newly unlocked achievements and stores the period end", () => {
    const next = advanceState(makeState({ unlocked: ["first-report"] }), makeWeek(), ["marathon"]);
    expect(next.unlocked).toEqual(["first-report", "marathon"]);
    expect(next.lastRunUntil).toBe(makeWeek().until);
  });
});
