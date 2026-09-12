import { describe, expect, it, vi } from "vitest";
import { resolvePrivateRepos } from "../src/repo-visibility";

const known = new Map([
  ["octocat/public", false],
  ["octocat/private", true],
]);

describe("resolvePrivateRepos", () => {
  it("takes known repos from the account list without lookups", async () => {
    const lookup = vi.fn();
    const result = await resolvePrivateRepos(known, ["octocat/public", "octocat/private"], lookup);
    expect([...result]).toEqual(["octocat/private"]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks up unknown repos and trusts an explicit flag", async () => {
    const lookup = vi.fn(async (name: string) => ({ private: name === "other/secret" }));
    const result = await resolvePrivateRepos(known, ["other/secret", "other/open"], lookup);
    expect([...result]).toEqual(["other/secret"]);
  });

  it("is fail-closed: a failed lookup or a missing flag counts as private", async () => {
    const lookup = vi.fn(async (name: string) => {
      if (name === "other/gone") throw new Error("GitHub /repos/other/gone -> 404");
      return {};
    });
    const result = await resolvePrivateRepos(known, ["other/gone", "other/odd"], lookup);
    expect(result).toEqual(new Set(["other/gone", "other/odd"]));
  });

  it("looks each unknown repo up once, however many PRs and issues point at it", async () => {
    const lookup = vi.fn(async () => ({ private: false }));
    await resolvePrivateRepos(known, ["other/open", "other/open", "other/open"], lookup);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("treats unknown repos over the lookup budget as private without asking", async () => {
    const names = Array.from({ length: 25 }, (_, i) => `other/r${i}`);
    const lookup = vi.fn(async () => ({ private: false }));
    const result = await resolvePrivateRepos(known, names, lookup);
    expect(lookup).toHaveBeenCalledTimes(20);
    expect([...result]).toEqual(names.slice(20));
  });
});
