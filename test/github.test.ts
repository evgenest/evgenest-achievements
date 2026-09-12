import { afterEach, describe, expect, it, vi } from "vitest";
import { collectWeekActivity, commitsFromHistory, type HistoryNode } from "../src/github";
import { applyPrivacy } from "../src/privacy";
import { makeConfig } from "./fixtures";

const node = (overrides: Partial<HistoryNode> = {}): HistoryNode => ({
  messageHeadline: "feat: thing",
  message: "feat: thing\n\nWhy the thing was needed.",
  committedDate: "2026-08-05T10:00:00Z",
  additions: 10,
  deletions: 1,
  url: "https://github.com/octocat/app/commit/a",
  parents: { totalCount: 1 },
  authoredDate: "2026-08-05T09:30:00Z",
  ...overrides,
});

describe("commitsFromHistory", () => {
  it("drops merge commits (more than one parent)", () => {
    const commits = commitsFromHistory([
      node({ messageHeadline: "feat: real work", additions: 300 }),
      node({ messageHeadline: "Merge pull request #1", additions: 300, parents: { totalCount: 2 } }),
      node({ messageHeadline: "octopus", parents: { totalCount: 3 } }),
    ]);
    expect(commits.map((c) => c.headline)).toEqual(["feat: real work"]);
  });

  it("keeps the headline for the report and the full message for the LLM", () => {
    expect(commitsFromHistory([node()])[0]).toMatchObject({
      headline: "feat: thing",
      message: "feat: thing\n\nWhy the thing was needed.",
    });
  });

  it("keeps root commits (no parents) and squash merges (one parent)", () => {
    expect(commitsFromHistory([node({ parents: { totalCount: 0 } }), node()])).toHaveLength(2);
  });

  it("carries the author date next to the committer date", () => {
    expect(commitsFromHistory([node()])[0]).toMatchObject({
      date: "2026-08-05T10:00:00Z",
      authoredDate: "2026-08-05T09:30:00Z",
    });
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
    expect(week.repos[0].commits.every((c) => !c.headline.startsWith("Merge"))).toBe(true);
  });

  it("resolves PR visibility past the first repo page and fail-closed for unknown repos", async () => {
    const repo = (full_name: string, isPrivate: boolean, pushed_at: string) => ({
      full_name,
      private: isPrivate,
      language: null,
      html_url: `https://github.com/${full_name}`,
      pushed_at,
      fork: false,
    });
    const pr = (fullName: string, title: string) => ({
      title,
      body: `${title} body`,
      html_url: `https://github.com/${fullName}/pull/1`,
      state: "open",
      repository_url: `https://api.github.com/repos/${fullName}`,
    });
    const page2 = "https://api.github.com/user/repos?per_page=100&sort=pushed&direction=desc&page=2";
    const lookups: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u === page2) return Response.json([repo("octocat/old-private", true, "2025-01-01T00:00:00Z")]);
        if (u.includes("/user/repos")) {
          return Response.json([repo("octocat/app", false, "2026-08-06T00:00:00Z")], {
            headers: { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` },
          });
        }
        if (u.endsWith("/graphql")) {
          if (String(init?.body).includes("viewer")) return Response.json({ data: { viewer: { id: "U_1" } } });
          return Response.json({ data: { r0: { defaultBranchRef: { target: { history: { nodes: [] } } } } } });
        }
        if (u.includes("/search/issues")) {
          if (!decodeURIComponent(u).includes("type:pr")) return Response.json({ items: [] });
          return Response.json({
            items: [
              pr("octocat/app", "PUBLIC-APP"),
              pr("octocat/old-private", "PAGE2-PRIVATE"),
              pr("other/secret", "LOOKUP-PRIVATE"),
              pr("other/secret", "LOOKUP-PRIVATE-AGAIN"),
              pr("other/open", "LOOKUP-PUBLIC"),
              pr("other/gone", "LOOKUP-FAILED"),
            ],
          });
        }
        const lookup = u.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/?]+)$/)?.[1];
        if (lookup) {
          lookups.push(lookup);
          if (lookup === "other/gone") return new Response("Not Found", { status: 404 });
          return Response.json({ private: lookup === "other/secret" });
        }
        throw new Error(`unexpected fetch ${u}`);
      }),
    );

    const env = { GITHUB_TOKEN: "t" } as unknown as Env;
    const week = await collectWeekActivity(env, makeConfig(), new Date("2026-08-01T00:00:00Z"), new Date("2026-08-08T00:00:00Z"));

    expect(Object.fromEntries(week.prs.map((p) => [p.title, p.isPrivate]))).toEqual({
      "PUBLIC-APP": false,
      "PAGE2-PRIVATE": true,
      "LOOKUP-PRIVATE": true,
      "LOOKUP-PRIVATE-AGAIN": true,
      "LOOKUP-PUBLIC": false,
      "LOOKUP-FAILED": true,
    });
    expect(lookups.sort()).toEqual(["other/gone", "other/open", "other/secret"]);

    const redacted = JSON.stringify(applyPrivacy(week, "redact").prs);
    for (const hidden of ["PAGE2-PRIVATE", "LOOKUP-PRIVATE", "LOOKUP-FAILED"]) expect(redacted).not.toContain(hidden);
    expect(redacted).toContain("LOOKUP-PUBLIC");
    expect(applyPrivacy(week, "skip").prs.map((p) => p.title)).toEqual(["PUBLIC-APP", "LOOKUP-PUBLIC"]);
  });
});
