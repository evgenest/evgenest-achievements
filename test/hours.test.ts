import { describe, expect, it } from "vitest";
import {
  buildCommitTimeline,
  heuristicMinutes,
  MAX_WINDOW_MINUTES,
  MIN_COMMIT_MINUTES,
  resolveHours,
  SESSION_START_MINUTES,
  WEEKLY_HOURS_CAP,
} from "../src/hours";
import { makeCommit, makeRepo, makeWeek } from "./fixtures";

const at = (hhmm: string, day = "05") => `2026-08-${day}T${hhmm}:00Z`;

describe("buildCommitTimeline", () => {
  it("merges all repos into one chronological timeline with global ids", () => {
    const week = makeWeek({
      repos: [
        makeRepo({ fullName: "octocat/a", commits: [makeCommit({ date: at("10:40") }), makeCommit({ date: at("10:00") })] }),
        makeRepo({ fullName: "octocat/b", commits: [makeCommit({ date: at("10:15") })] }),
      ],
    });
    const timeline = buildCommitTimeline(week);
    expect(timeline.map((t) => [t.id, t.repo, t.windowMinutes, t.startsSession])).toEqual([
      [0, "octocat/a", SESSION_START_MINUTES, true],
      [1, "octocat/b", 15, false], // time is shared: the gap is measured across repos
      [2, "octocat/a", 25, false],
    ]);
  });

  it("starts a new session after a long pause instead of claiming the gap", () => {
    const week = makeWeek({
      repos: [makeRepo({ commits: [makeCommit({ date: at("09:00") }), makeCommit({ date: at("18:00") })] })],
    });
    const [, second] = buildCommitTimeline(week);
    expect(second).toMatchObject({ startsSession: true, windowMinutes: SESSION_START_MINUTES });
  });

  it("caps a long in-session gap at the max window", () => {
    const week = makeWeek({
      repos: [makeRepo({ commits: [makeCommit({ date: at("09:00") }), makeCommit({ date: at("11:50") })] })],
    });
    expect(buildCommitTimeline(week)[1]).toMatchObject({ startsSession: false, windowMinutes: MAX_WINDOW_MINUTES });
  });

  it("prefers the author date, so rebased commits keep their real spacing", () => {
    // After a rebase every commit carries the same committer date.
    const rebased = "2026-08-05T18:00:00Z";
    const week = makeWeek({
      repos: [
        makeRepo({
          commits: [
            makeCommit({ date: rebased, authoredDate: at("10:45") }),
            makeCommit({ date: rebased, authoredDate: at("10:00") }),
          ],
        }),
      ],
    });
    expect(buildCommitTimeline(week).map((t) => t.windowMinutes)).toEqual([SESSION_START_MINUTES, 45]);
  });

  it("never produces a zero window for same-minute commits", () => {
    const week = makeWeek({
      repos: [makeRepo({ commits: [makeCommit({ date: at("10:00") }), makeCommit({ date: at("10:00") })] })],
    });
    expect(buildCommitTimeline(week)[1].windowMinutes).toBe(1);
  });

  it("includes redacted repos (timing only) under their placeholder", () => {
    const week = makeWeek({ repos: [makeRepo({ displayName: "private-project-1", redacted: true, isPrivate: true })] });
    expect(buildCommitTimeline(week)[0]).toMatchObject({ repo: "private-project-1", redacted: true });
  });
});

describe("resolveHours", () => {
  const week = makeWeek({
    repos: [
      makeRepo({
        commits: [
          makeCommit({ date: at("10:00"), additions: 200, deletions: 0 }),
          makeCommit({ date: at("10:40"), additions: 15, deletions: 0 }),
          makeCommit({ date: at("13:10"), additions: 5, deletions: 0 }),
        ],
      }),
    ],
  });
  const timeline = buildCommitTimeline(week); // windows: 120, 40, 150

  it("uses the model's minutes when they fit the window", () => {
    const r = resolveHours(timeline, [
      { id: 0, minutes: 90 },
      { id: 1, minutes: 25 },
      { id: 2, minutes: 10 },
    ]);
    expect(r.perCommit).toEqual([90, 25, 10]);
    expect(r.hours).toBe(2.1); // 125 min
    expect(r).toMatchObject({ fromModel: 3, fallback: 0, capped: false });
  });

  it("clamps estimates into [minimum, window]", () => {
    const r = resolveHours(timeline, [
      { id: 0, minutes: 500 }, // above the 120-minute window
      { id: 1, minutes: 0 }, // below the floor
      { id: 2, minutes: 10 },
    ]);
    expect(r.perCommit).toEqual([120, MIN_COMMIT_MINUTES, 10]);
  });

  it("falls back to the heuristic for missing, unknown, negative or duplicate ids", () => {
    const r = resolveHours(timeline, [
      { id: 0, minutes: 60 },
      { id: 0, minutes: 5 }, // duplicate: first answer wins
      { id: 1, minutes: -3 },
      { id: 99, minutes: 30 },
      { id: 1.5, minutes: 30 },
    ]);
    expect(r.perCommit[0]).toBe(60);
    expect(r.perCommit[1]).toBe(Math.min(40, heuristicMinutes(week.repos[0].commits[1])));
    expect(r.perCommit[2]).toBe(heuristicMinutes(week.repos[0].commits[2]));
    expect(r).toMatchObject({ fromModel: 1, fallback: 2 });
  });

  it("is fully deterministic without any model answer", () => {
    expect(resolveHours(timeline, undefined)).toEqual(resolveHours(timeline, []));
    expect(resolveHours(timeline, []).fallback).toBe(3);
  });

  it("keeps the heuristic inside the window too", () => {
    const big = makeWeek({
      repos: [
        makeRepo({
          commits: [makeCommit({ date: at("10:00") }), makeCommit({ date: at("10:03"), additions: 5000, deletions: 0 })],
        }),
      ],
    });
    expect(resolveHours(buildCommitTimeline(big), []).perCommit[1]).toBe(3);
  });

  it("applies the weekly ceiling", () => {
    // 60 sessions × 120 min = 120 h of windows, the model claims all of it
    const commits = Array.from({ length: 60 }, (_, i) =>
      makeCommit({ date: new Date(Date.UTC(2026, 7, 1) + i * 4 * 3600_000).toISOString() }),
    );
    const tl = buildCommitTimeline(makeWeek({ repos: [makeRepo({ commits })] }));
    const r = resolveHours(tl, tl.map((t) => ({ id: t.id, minutes: 120 })));
    expect(r.hours).toBe(WEEKLY_HOURS_CAP);
    expect(r.capped).toBe(true);
  });

  it("is zero for a week without commits", () => {
    expect(resolveHours(buildCommitTimeline(makeWeek({ repos: [] })), []).hours).toBe(0);
  });
});
