import { describe, expect, it } from "vitest";
import { applyPrivacy } from "../src/privacy";
import { makeCommit, makeIssue, makePr, makeRepo, makeWeek } from "./fixtures";

const privateRepo = makeRepo({
  fullName: "octocat/secret-thing",
  displayName: "octocat/secret-thing",
  isPrivate: true,
  commits: [
    makeCommit({
      headline: "feat: acquisition pricing model",
      message: "feat: acquisition pricing model\n\nMargins for the client deal",
      url: "https://github.com/octocat/secret-thing/commit/a",
    }),
  ],
});

const week = () =>
  makeWeek({
    repos: [makeRepo(), privateRepo],
    prs: [
      makePr(),
      makePr({ title: "Secret PR", body: "Secret PR description", repo: "octocat/secret-thing", isPrivate: true }),
    ],
    issues: [
      makeIssue({ title: "Secret issue", body: "Secret issue description", repo: "octocat/secret-thing", isPrivate: true }),
    ],
  });

describe("applyPrivacy", () => {
  it("full: leaves everything untouched", () => {
    const result = applyPrivacy(week(), "full");
    expect(result).toEqual(week());
  });

  it("skip: removes private repos, prs and issues and recomputes totals", () => {
    const result = applyPrivacy(week(), "skip");
    expect(result.repos.map((r) => r.fullName)).toEqual(["octocat/public-repo"]);
    expect(result.prs).toHaveLength(1);
    expect(result.issues).toHaveLength(0);
    expect(result.totalCommits).toBe(1);
    expect(JSON.stringify(result)).not.toContain("secret-thing");
    expect(JSON.stringify(result)).not.toContain("Secret");
  });

  it("redact: keeps metrics but strips names, messages and links", () => {
    const result = applyPrivacy(week(), "redact");
    const redacted = result.repos.find((r) => r.redacted);

    expect(redacted?.displayName).toBe("private-project-1");
    expect(redacted?.url).toBe("");
    expect(redacted?.commits[0]).toMatchObject({ headline: "", message: "", url: "" });
    expect(redacted?.commits[0].date).toBe(privateRepo.commits[0].date);
    expect(redacted?.additions).toBe(privateRepo.additions);
    expect(result.totalCommits).toBe(week().totalCommits);
  });

  it("redact: clears PR and issue titles and descriptions", () => {
    const result = applyPrivacy(week(), "redact");
    expect(result.prs.find((p) => p.redacted)).toMatchObject({ title: "", body: "", url: "" });
    expect(result.issues.find((i) => i.redacted)).toMatchObject({ title: "", body: "", url: "" });
  });

  it("redact: reuses one placeholder per repository across prs and issues", () => {
    const result = applyPrivacy(week(), "redact");
    expect(result.prs.find((p) => p.redacted)?.repo).toBe("private-project-1");
    expect(result.issues.find((i) => i.redacted)?.repo).toBe("private-project-1");
  });

  it("redact: no private name, title, message or description survives serialization", () => {
    const serialized = JSON.stringify(applyPrivacy(week(), "redact"));
    expect(serialized).not.toContain("secret-thing");
    expect(serialized).not.toContain("Secret PR");
    expect(serialized).not.toContain("Secret issue");
    expect(serialized).not.toContain("acquisition pricing model");
    expect(serialized).not.toContain("Margins for the client deal");
    expect(serialized).not.toContain("description");
  });

  it("redact: public activity keeps its names, links, messages and descriptions", () => {
    const result = applyPrivacy(week(), "redact");
    const publicRepo = result.repos.find((r) => !r.redacted);
    expect(publicRepo?.displayName).toBe("octocat/public-repo");
    expect(publicRepo?.url).toContain("https://");
    expect(publicRepo?.commits[0].message).toContain("Adds the thing behind a feature flag.");
    expect(result.prs.find((p) => !p.redacted)?.body).toBe("Implements the feature and covers it with tests.");
  });
});
