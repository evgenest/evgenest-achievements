const MAX_LOOKUPS = 20; // Workers subrequest budget: one GET /repos/{owner}/{repo} per unknown repo

/**
 * Which of the given repositories are private. PR/issue search results carry no visibility
 * flag, and the account's repo list (`known`: full_name → private) can miss a repo — past
 * its last fetched page, or someone else's private repo the author opened a PR in. Every
 * such repo gets one lookup (deduplicated, in parallel), and the check is fail-closed: a
 * repo whose visibility is not confirmed — the lookup failed (404, 403, network), returned
 * no flag, or went over the lookup budget — counts as private. Worst case a public PR is
 * hidden, never a private one shown.
 */
export async function resolvePrivateRepos(
  known: ReadonlyMap<string, boolean>,
  repos: Iterable<string>,
  lookup: (fullName: string) => Promise<{ private?: boolean }>,
): Promise<Set<string>> {
  const unique = [...new Set(repos)];
  const privateNames = new Set(unique.filter((r) => known.get(r) === true));
  const unknown = unique.filter((r) => !known.has(r));
  const checked = unknown.slice(0, MAX_LOOKUPS);

  const results = await Promise.allSettled(checked.map((r) => lookup(r)));
  results.forEach((res, i) => {
    if (res.status !== "fulfilled" || res.value.private !== false) privateNames.add(checked[i]);
  });
  for (const r of unknown.slice(MAX_LOOKUPS)) privateNames.add(r);
  return privateNames;
}
