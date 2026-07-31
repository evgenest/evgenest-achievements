import type { CommitInfo, IssueInfo, PrInfo, RepoActivity, WeekActivity } from "./types";

const API = "https://api.github.com";
const MAX_REPOS = 15;

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "github-weekly-digest-worker",
  };
}

async function rest<T>(env: Env, path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: headers(env.GITHUB_TOKEN) });
  if (!res.ok) {
    throw new Error(`GitHub ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function graphql<T>(env: Env, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...headers(env.GITHUB_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub GraphQL -> ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { data?: T; errors?: unknown[] };
  if (data.errors?.length) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(data.errors).slice(0, 500)}`);
  }
  if (!data.data) throw new Error("GitHub GraphQL: empty data");
  return data.data;
}

interface RestRepo {
  full_name: string;
  private: boolean;
  language: string | null;
  html_url: string;
  pushed_at: string;
  fork: boolean;
}

interface HistoryNode {
  messageHeadline: string;
  committedDate: string;
  additions: number;
  deletions: number;
  url: string;
}

/** Коммиты default-ветки всех активных репо одним GraphQL-запросом (алиасы). */
async function fetchCommits(env: Env, repos: RestRepo[], since: string): Promise<Map<string, CommitInfo[]>> {
  if (repos.length === 0) return new Map();
  const { viewer } = await graphql<{ viewer: { id: string } }>(env, "query { viewer { id } }", {});

  const parts = repos.map((r, i) => {
    const [owner, name] = r.full_name.split("/");
    return `r${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      defaultBranchRef { target { ... on Commit {
        history(since: $since, author: { id: $authorId }, first: 100) {
          nodes { messageHeadline committedDate additions deletions url }
        }
      } } }
    }`;
  });
  const query = `query($since: GitTimestamp!, $authorId: ID) { ${parts.join("\n")} }`;
  type RepoHistory = {
    defaultBranchRef: { target: { history: { nodes: HistoryNode[] } } | null } | null;
  } | null;
  const data = await graphql<Record<string, RepoHistory>>(env, query, { since, authorId: viewer.id });

  const result = new Map<string, CommitInfo[]>();
  repos.forEach((r, i) => {
    const nodes = (data[`r${i}`]?.defaultBranchRef?.target as { history?: { nodes: HistoryNode[] } } | null | undefined)
      ?.history?.nodes ?? [];
    result.set(
      r.full_name,
      nodes.map((n) => ({
        message: n.messageHeadline,
        date: n.committedDate,
        additions: n.additions,
        deletions: n.deletions,
        url: n.url,
      })),
    );
  });
  return result;
}

const MAX_CI_REPOS = 10; // лимит субзапросов Workers: Actions/Deployments API только per-repo

interface WorkflowRun {
  conclusion: string | null;
}

/** Сводка CI-прогонов и деплоев по репо за неделю. */
async function fetchOps(
  env: Env,
  fullName: string,
  sinceIso: string,
): Promise<{ ciSuccess: number; ciFailure: number; deployments: number }> {
  const sinceDay = sinceIso.slice(0, 10);
  const [runsRes, deploysRes] = await Promise.allSettled([
    rest<{ workflow_runs: WorkflowRun[] }>(
      env,
      `/repos/${fullName}/actions/runs?created=${encodeURIComponent(`>=${sinceDay}`)}&per_page=100`,
    ),
    rest<{ created_at: string }[]>(env, `/repos/${fullName}/deployments?per_page=30`),
  ]);
  const runs = runsRes.status === "fulfilled" ? runsRes.value.workflow_runs : [];
  const deploys = deploysRes.status === "fulfilled" ? deploysRes.value : [];
  return {
    ciSuccess: runs.filter((r) => r.conclusion === "success").length,
    ciFailure: runs.filter((r) => r.conclusion === "failure").length,
    deployments: deploys.filter((d) => d.created_at >= sinceIso).length,
  };
}

interface SearchItem {
  title: string;
  html_url: string;
  state: string;
  repository_url: string;
  pull_request?: { merged_at: string | null };
}

async function searchIssues(env: Env, q: string): Promise<SearchItem[]> {
  const data = await rest<{ items: SearchItem[] }>(
    env,
    `/search/issues?q=${encodeURIComponent(q)}&per_page=50&advanced_search=true`,
  );
  return data.items;
}

function repoFromApiUrl(repositoryUrl: string): string {
  return repositoryUrl.replace(`${API}/repos/`, "");
}

export async function collectWeekActivity(env: Env, since: Date, until: Date): Promise<WeekActivity> {
  const sinceIso = since.toISOString();
  const sinceDay = sinceIso.slice(0, 10);

  const allRepos = await rest<RestRepo[]>(env, "/user/repos?per_page=100&sort=pushed&direction=desc");
  const active = allRepos.filter((r) => r.pushed_at >= sinceIso).slice(0, MAX_REPOS);

  const [commitsByRepo, prItems, issueItems] = await Promise.all([
    fetchCommits(env, active, sinceIso),
    searchIssues(env, `author:${env.GITHUB_USER} type:pr updated:>=${sinceDay}`),
    searchIssues(env, `author:${env.GITHUB_USER} type:issue updated:>=${sinceDay}`),
  ]);

  const withCommits = active.filter((r) => (commitsByRepo.get(r.full_name) ?? []).length > 0);
  const opsByRepo = new Map(
    await Promise.all(
      withCommits.slice(0, MAX_CI_REPOS).map(async (r) => [r.full_name, await fetchOps(env, r.full_name, sinceIso)] as const),
    ),
  );

  const repos: RepoActivity[] = withCommits.map((r) => {
    const commits = commitsByRepo.get(r.full_name) ?? [];
    const ops = opsByRepo.get(r.full_name) ?? { ciSuccess: 0, ciFailure: 0, deployments: 0 };
    return {
      fullName: r.full_name,
      isPrivate: r.private,
      language: r.language,
      url: r.html_url,
      commits,
      additions: commits.reduce((s, c) => s + c.additions, 0),
      deletions: commits.reduce((s, c) => s + c.deletions, 0),
      ...ops,
    };
  });

  const prs: PrInfo[] = prItems.map((i) => ({
    title: i.title,
    repo: repoFromApiUrl(i.repository_url),
    state: i.pull_request?.merged_at ? "merged" : (i.state as "open" | "closed"),
    url: i.html_url,
  }));

  const issues: IssueInfo[] = issueItems.map((i) => ({
    title: i.title,
    repo: repoFromApiUrl(i.repository_url),
    state: i.state,
    url: i.html_url,
  }));

  return {
    since: sinceIso,
    until: until.toISOString(),
    repos,
    prs,
    issues,
    totalCommits: repos.reduce((s, r) => s + r.commits.length, 0),
    totalAdditions: repos.reduce((s, r) => s + r.additions, 0),
    totalDeletions: repos.reduce((s, r) => s + r.deletions, 0),
  };
}

/** Коммит markdown-отчёта в репозиторий через Contents API. Возвращает html_url файла. */
export async function commitFile(env: Env, path: string, content: string, message: string): Promise<string> {
  const url = `${API}/repos/${env.REPORTS_REPO}/contents/${path}`;
  const existing = await fetch(url, { headers: headers(env.GITHUB_TOKEN) });
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;

  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers(env.GITHUB_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: btoa(String.fromCharCode(...new TextEncoder().encode(content))),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) {
    throw new Error(`GitHub commit ${path} -> ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { content: { html_url: string } };
  return data.content.html_url;
}
