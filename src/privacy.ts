import type { PrivacyMode } from "./config";
import type { IssueInfo, PrInfo, RepoActivity, WeekActivity } from "./types";

/**
 * Applies PRIVATE_REPOS policy to collected activity.
 *
 * Runs before anything leaves the worker: the report, the LLM payload and the
 * Telegram message all derive from the transformed object, so private names,
 * commit messages, issue titles and URLs cannot leak through any of them.
 */
export function applyPrivacy(week: WeekActivity, mode: PrivacyMode): WeekActivity {
  if (mode === "full") return week;
  if (mode === "skip") return dropPrivate(week);
  return redactPrivate(week);
}

function dropPrivate(week: WeekActivity): WeekActivity {
  const repos = week.repos.filter((r) => !r.isPrivate);
  return {
    ...week,
    repos,
    prs: week.prs.filter((p) => !p.isPrivate),
    issues: week.issues.filter((i) => !i.isPrivate),
    totalCommits: repos.reduce((s, r) => s + r.commits.length, 0),
    totalAdditions: repos.reduce((s, r) => s + r.additions, 0),
    totalDeletions: repos.reduce((s, r) => s + r.deletions, 0),
  };
}

function redactPrivate(week: WeekActivity): WeekActivity {
  const placeholders = new Map<string, string>();
  const placeholderFor = (fullName: string): string => {
    const existing = placeholders.get(fullName);
    if (existing) return existing;
    const name = `private-project-${placeholders.size + 1}`;
    placeholders.set(fullName, name);
    return name;
  };

  // Repos first so that PRs and issues reuse the same placeholder per repository.
  const repos: RepoActivity[] = week.repos.map((r) => {
    if (!r.isPrivate) return r;
    const placeholder = placeholderFor(r.fullName);
    // fullName is overwritten too: after this point the real name exists nowhere in the
    // object, so no future consumer can reach for the "original" field and leak it.
    return {
      ...r,
      fullName: placeholder,
      displayName: placeholder,
      redacted: true,
      url: "",
      // Counts and dates stay (metrics, night-owl achievement); text and links go.
      commits: r.commits.map((c) => ({ ...c, message: "", url: "" })),
    };
  });

  const prs: PrInfo[] = week.prs.map((p) =>
    p.isPrivate ? { ...p, repo: placeholderFor(p.repo), redacted: true, title: "", url: "" } : p,
  );
  const issues: IssueInfo[] = week.issues.map((i) =>
    i.isPrivate ? { ...i, repo: placeholderFor(i.repo), redacted: true, title: "", url: "" } : i,
  );

  return { ...week, repos, prs, issues };
}
