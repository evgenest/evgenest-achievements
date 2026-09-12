import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWeekActivity, commitsFromHistory, type HistoryNode } from "../src/github";
import { makeConfig } from "./fixtures";

const node = (overrides: Partial<HistoryNode> = {}): HistoryNode => ({
  messageHeadline: "feat: thing",
  committedDate: "2026-08-05T10:00:00Z",
  additions: 10,
  deletions: 1,
  url: "https://github.com/octocat/app/commit/a",
  parents: { totalCount: 1 },
  ...overrides,
});

describe("commitsFromHistory", () => {
  it("drops merge commits (more than one parent)", () => {
    const commits = commitsFromHistory([
      node({ messageHeadline: "feat: real work", additions: 300 }),
      node({ messageHeadline: "Merge pull request #1", additions: 300, parents: { totalCount: 2 } }),
      node({ messageHeadline: "octopus", parents: { totalCount: 3 } }),
    ]);
    expect(commits.map((c) => c.message)).toEqual(["feat: real work"]);
  });

  it("keeps root commits (no parents) and squash merges (one parent)", () => {
    expect(commitsFromHistory([node({ parents: { totalCount: 0 } }), node()])).toHaveLength(2);
  });
});

describe("collectWeekActivity", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("excludes merge commits from commit counts and line totals", async () => {
    const history = [
      node({ additions: 100, deletions: 5 }),
      node({ additions: 20, deletions: 0 }),
      node({ messageHeadline: "Merge branch 'feature'", additions: 120, deletions: 5, parents: { totalCount: 2 } }),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/user/repos")) {
          return Response.json([
            {
              full_name: "octocat/app",
              private: false,
              language: "TypeScript",
              html_url: "https://github.com/octocat/app",
              pushed_at: "2026-08-06T00:00:00Z",
              fork: false,
            },
          ]);
        }
        if (u.endsWith("/graphql")) {
          const body = String(init?.body);
          if (body.includes("viewer")) return Response.json({ data: { viewer: { id: "U_1" } } });
          expect(body).toContain("parents { totalCount }");
          return Response.json({ data: { r0: { defaultBranchRef: { target: { history: { nodes: history } } } } } });
        }
        if (u.includes("/search/issues")) return Response.json({ items: [] });
        if (u.includes("/actions/runs")) return Response.json({ workflow_runs: [] });
        if (u.includes("/deployments")) return Response.json([]);
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const env = { GITHUB_TOKEN: "t" } as unknown as Env;
    const week = await collectWeekActivity(env, makeConfig(), new Date("2026-08-01T00:00:00Z"), new Date("2026-08-08T00:00:00Z"));

    expect(week.totalCommits).toBe(2);
    expect(week.totalAdditions).toBe(120);
    expect(week.totalDeletions).toBe(5);
    expect(week.repos[0].commits.every((c) => !c.message.startsWith("Merge"))).toBe(true);
  });
});
