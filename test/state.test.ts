import { describe, expect, it } from "vitest";
import { advanceState, deleteLatestState, isActiveWeek, listStateVersions, loadState, saveState } from "../src/state";
import { makeKvEnv, makeRepo, makeState, makeWeek } from "./fixtures";

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

describe("state history", () => {
  const at = (iso: string) => new Date(iso);

  it("keeps every run as its own key and reads back the newest", async () => {
    const env = makeKvEnv();
    await saveState(env, makeState({ reportCount: 1 }), at("2026-08-07T08:00:00Z"));
    const key = await saveState(env, makeState({ reportCount: 2 }), at("2026-08-14T08:00:00Z"));

    expect(key).toBe("state:2026-08-14T08:00:00.000Z");
    expect((await listStateVersions(env)).map((v) => v.key)).toEqual([
      "state:2026-08-07T08:00:00.000Z",
      "state:2026-08-14T08:00:00.000Z",
    ]);
    expect((await loadState(env)).reportCount).toBe(2);
  });

  it("stores listable metadata for each snapshot", async () => {
    const env = makeKvEnv();
    await saveState(env, makeState({ reportCount: 3, streak: 2, lastRunUntil: "2026-08-14T08:00:00Z" }));
    expect((await listStateVersions(env))[0].meta).toMatchObject({
      until: "2026-08-14T08:00:00Z",
      reportCount: 3,
      streak: 2,
    });
  });

  it("rolls back to the previous snapshot when the latest is deleted", async () => {
    const env = makeKvEnv();
    await saveState(env, makeState({ reportCount: 1, streak: 1 }), at("2026-08-07T08:00:00Z"));
    await saveState(env, makeState({ reportCount: 2, streak: 2 }), at("2026-08-14T08:00:00Z"));

    expect(await deleteLatestState(env)).toBe("state:2026-08-14T08:00:00.000Z");
    expect(await loadState(env)).toMatchObject({ reportCount: 1, streak: 1 });
  });

  it("reports nothing to delete on an empty history", async () => {
    expect(await deleteLatestState(makeKvEnv())).toBeNull();
  });

  it("starts from an empty state once every snapshot is gone", async () => {
    const env = makeKvEnv();
    await saveState(env, makeState({ reportCount: 1 }));
    await deleteLatestState(env);
    expect(await loadState(env)).toMatchObject({ reportCount: 0, streak: 0, unlocked: [] });
  });

  it("migrates the pre-versioning single key", async () => {
    const env = makeKvEnv();
    await env.STATE.put("state", JSON.stringify(makeState({ reportCount: 7, bestStreak: 4 })));

    expect(await loadState(env)).toMatchObject({ reportCount: 7, bestStreak: 4 });

    await saveState(env, makeState({ reportCount: 8 }));
    expect((await loadState(env)).reportCount).toBe(8); // versioned snapshot wins from now on
  });

  it("prunes snapshots beyond the history limit, keeping the newest", async () => {
    const env = makeKvEnv();
    const start = at("2026-01-02T08:00:00Z").getTime();
    const day = 24 * 60 * 60 * 1000;
    for (let i = 0; i < 55; i++) {
      await saveState(env, makeState({ reportCount: i }), new Date(start + i * day));
    }
    const versions = await listStateVersions(env);
    expect(versions).toHaveLength(52);
    expect(versions[0].key).toBe("state:2026-01-05T08:00:00.000Z");
    expect((await loadState(env)).reportCount).toBe(54);
  });

  it("walks every list page when the history spans more than one", async () => {
    const env = makeKvEnv(2);
    for (let i = 1; i <= 5; i++) {
      await saveState(env, makeState({ reportCount: i }), at(`2026-02-0${i}T08:00:00Z`));
    }
    expect(await listStateVersions(env)).toHaveLength(5);
    expect((await loadState(env)).reportCount).toBe(5);
  });
});
