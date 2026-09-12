# Weekly GitHub Achievements

A Cloudflare Worker that turns a week of your GitHub activity into a report you actually want to read.

Once a week it scans every repository you touched — commits, pull requests, issues, CI runs, deployments — asks an LLM to describe what was accomplished (per project, in plain language) and how long each commit realistically took, computes focused hours and an optional "what this week was worth on the market" estimate from that, commits the markdown to a reports repository and sends a short summary to Telegram. Streaks, achievements and cached market rates are kept across runs in Workers KV.

It was built as a personal "wall of fame" for a developer who tends to undervalue their own work. Everything personal about it — the profile, the language, the currency, the time zone, the tone — is configuration.

## How it works

```
cron (weekly)
  └─ collect GitHub activity (REST + GraphQL)
       └─ apply privacy policy for private repos
            ├─ sanitize → LLM (OpenAI, Vercel AI Gateway or OpenRouter)
            ├─ market rates: KV cache, web search only when stale (optional)
            └─ focused hours + cost computed in code
                 └─ build markdown → commit to reports repo
                      └─ Telegram notification
                           └─ persist streak / totals / achievements / rates in KV
```

- **Cloudflare Worker** with a cron trigger, plus authenticated `/run` and `/state` endpoints for manual runs and rolling them back
- **GitHub API**: REST (repo list, PR/issue search, committing the report) and GraphQL (commits with per-commit stats in a single request)
- **LLM**: OpenAI Responses API directly, the Vercel AI Gateway (`@ai-sdk/gateway` + `ai`), or OpenRouter restricted to zero-data-retention endpoints (`@openrouter/ai-sdk-provider` + `ai`) — switched with `LLM_PROVIDER`. Structured output in every case
- **Web search** (only for the optional salary estimate, only when cached rates are stale): a provider-executed search tool through the AI SDK — `openai.tools.webSearch()` from `@ai-sdk/openai` with `LLM_PROVIDER=openai`, the Gateway's `perplexitySearch` with `LLM_PROVIDER=vercel`, OpenRouter's `web_search` server tool with `LLM_PROVIDER=openrouter` (see [Focused hours and salary estimate](#focused-hours-and-salary-estimate))
- **Workers KV**: streak, all-time totals, unlocked achievements, previous-week snapshot, cached market rates — appended as a new snapshot per run, so a test run can be rolled back (see [State history](#state-history))
- **Telegram Bot API**: outbound `sendMessage` only, no webhook
- Every report ends with a `provider/model` signature line, so a report stays self-describing even after `LLM_PROVIDER`/`LLM_MODEL` change later

## Modules

```
src/index.ts        — scheduled handler + fetch (manual /run)
src/run.ts          — weekly run orchestrator
src/config.ts       — env → validated config with defaults
src/github.ts       — activity collection + committing the report
src/privacy.ts      — private repository policy (full / redact / skip)
src/repo-visibility.ts — fail-closed visibility of repos behind PRs/issues
src/sanitize.ts     — data guard for everything sent to the LLM
src/secrets.ts      — secret scrubbing for LLM-bound text (fail-closed re-check)
src/llm.ts          — prompt and model call
src/hours.ts        — commit timeline, time windows, focused-hours math
src/rates.ts        — market-rate cache (freshness, fallbacks)
src/rates-lookup.ts — market-rate lookup: profile extraction + web search
src/rates-prompt.ts — prompts of the rate lookup
src/cost.ts         — hours × rates arithmetic
src/report.ts       — markdown assembly
src/telegram.ts     — notifications
src/state.ts        — KV-backed state (append-only snapshot history)
src/achievements.ts — achievement rules
src/i18n/           — all user-facing copy (en, ru)
src/time.ts         — time-zone-aware date helpers
```

## What reaches the LLM

The GitHub token can read code, but the application never asks for any: it only reads full commit messages (headline + body), line counters, commit times, PR/issue titles and descriptions, languages, and CI/deployment statistics. Before a request is made, the payload goes through `src/sanitize.ts`:

- a single exit point — the payload is an explicit projection over an allowlist of fields;
- every key of the finished payload is checked recursively, fail-closed: an unknown key raises an error instead of being sent;
- free text (commit messages, PR/issue titles and descriptions) loses its HTML comments, gets secret-like substrings replaced with `[secret]` and is then clipped to 1000 characters;
- every string of the finished payload is re-scanned for secrets, fail-closed: anything secret-like left over blocks the LLM call instead of being sent.

Commits are sent as one chronological list across all repositories: id, repository, full message (headline + body), lines added/removed, and the time window in minutes since the previous commit (plus whether it starts a new work session). Commit timestamps themselves are not sent. For repositories redacted by `PRIVATE_REPOS=redact` each commit contributes only its line counters and time window — no name, no text (before, redacted repos contributed per-repository counters only).

The scrubber (`src/secrets.ts`) covers PEM private key blocks, `scheme://user:password@` credentials, JWTs, `sk-…` API keys, GitHub tokens (`ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`), AWS access key IDs (`AKIA`/`ASIA`), Slack tokens (`xoxa-`/`xoxb-`/`xoxp-`/`xoxr-`/`xoxs-`), Telegram bot tokens, `Bearer <token>`, hex runs of 32+ characters (a 40-character git SHA is kept) and random-looking base64 runs of 32+ characters. It is a heuristic for credential-shaped strings, not a privacy filter.

File contents, diffs and patches cannot get there by construction. Commit messages and descriptions are human-written, though, and may quote code, links or internal details on their own — for private repositories that is what `PRIVATE_REPOS=redact` is for. The markdown report still lists commit headlines only. The same payload and the same path are used for every LLM provider. The optional market-rate lookup is a separate call with its own, much smaller input — see below.

With `LLM_PROVIDER=openrouter` every model request — the weekly report and the market-rate calls — is additionally pinned to zero-data-retention endpoints (`provider.zdr`, `data_collection: "deny"`, `src/openrouter.ts`): the model provider keeps neither the prompt nor the completion and cannot train on them. This is hardcoded, not a setting — if no ZDR endpoint can serve the model with strict structured output, the request fails instead of falling back. ZDR does not extend to OpenRouter's web search tool: its queries reach the search engine under that engine's own policy, and they are built from the extracted role/seniority/stack/region only (see below). OpenRouter itself does not store prompts unless prompt logging is enabled in the account's privacy settings; keep it off.

## Focused hours and salary estimate

### Hours

The model does not guess a weekly number. Every non-merge commit of the week, from every repository, goes on **one timeline** (a developer's time is shared between projects), ordered by author date — rebases rewrite the committer date of every commit to the same moment. Each commit gets a **window**: the minutes that actually passed since the previous commit. The model estimates, per commit, how many focused minutes the change took (size, complexity, message); code then:

1. clamps each estimate into `[5 min, window]`;
2. uses a deterministic heuristic (grows with the square root of the lines touched, still clamped into the window) for any commit the model skipped or answered with garbage;
3. sums everything up and caps the week at 60 h.

A long window is a ceiling, not the answer: a one-line fix two hours after the previous commit is still a few minutes. The knobs live together at the top of `src/hours.ts`:

| Constant | Value | Meaning |
|---|---|---|
| `SESSION_GAP_MINUTES` | 180 | A longer pause ends the work session |
| `SESSION_START_MINUTES` | 120 | Window of the first commit of a session (the time before it is unknown) |
| `MAX_WINDOW_MINUTES` | 150 | No commit can claim more, whatever the gap |
| `MIN_COMMIT_MINUTES` | 5 | Floor per commit (never above its window) |
| `WEEKLY_HOURS_CAP` | 60 | Ceiling on the weekly total |

Example — four commits on one day:

| Time | Repo | Change | Window | Model says | Counted |
|---|---|---|---:|---:|---:|
| 10:00 | app | +200/−20 | 120 (new session) | 90 | 90 |
| 10:40 | lib | +15/−3 | 40 | 25 | 25 |
| 13:10 | app | +5/−1 | 150 | 10 | 10 |
| 19:00 | app | +400/−50 | 120 (new session, 5 h 50 min gap) | 180 | 120 |

245 min ≈ **4.1 h**. Merge commits are excluded from everything (they repeat the lines of the merged branch), and hours only come from commits — reviews, issues and meetings are not counted.

### Salary

Only with `ENABLE_SALARY_ESTIMATE=true`. The amounts are arithmetic in code, never model output:

- employed: `annual gross ÷ 52 × hours ÷ 40`;
- freelance: `hours × hourly rate`.

The two rates are **cached in the KV state** (with region, source links, fetch date, currency and a SHA-256 of `DEV_PROFILE` — never the profile text) and reused, so weeks stay comparable. A new lookup happens only when there is no cache, it is older than 90 days, `DEV_PROFILE` changed (hash) or `CURRENCY` changed. A lookup is three steps:

1. **Extract** — a tool-less call turns `DEV_PROFILE` into role, seniority, main stack, region and country code, and is told to drop names, employers, clients, contacts and income. This is the only call that sees the profile text.
2. **Search** — a second call gets only that extract (plus currency and date) and a provider-executed web search tool, and returns both rates, a region label and 1-5 source links as structured output. It is told to prefer the most popular job sites and salary databases for the region and to put nothing but role/seniority/stack/region into search queries. With `LLM_PROVIDER=openai` the tool is OpenAI's web search; with `LLM_PROVIDER=vercel` it is Perplexity search executed by the AI Gateway (so it works with any model the Gateway routes to), filtered to the extracted country; with `LLM_PROVIDER=openrouter` it is OpenRouter's `web_search` server tool (the model's native search where it has one, Exa otherwise; no country filter), which zero data retention does not cover. Whatever the search provider receives is built from those extracted fields only. Links are kept only if the search actually returned them.
3. **Fallback** — if the search call fails or the model/tool doesn't support it, the same question is asked without tools (the model's own knowledge). Such rates carry no sources, say so in the report, and are cached for 7 days only, so a real search is retried soon.

If every step fails, the previous (stale) rates are reused when they are in the same currency; otherwise the salary section is left out. A rates failure never fails the weekly run. The report's cost section lists the hours, both amounts, the rates used, the region, the fetch date and the source links.

Rolling back a run (`DELETE /state/latest`) also drops rates that run looked up — handy for forcing a fresh lookup.

## Private repositories

`PRIVATE_REPOS` decides what happens to repositories GitHub marks private:

| Mode | Effect |
|---|---|
| `full` | Names, commit headlines and links appear in the report as-is; the LLM gets full commit messages and PR/issue descriptions (secret-scrubbed, clipped), same as for public repositories. Only sensible if the reports repository is private. |
| `redact` | The repository is still counted (commits, lines, CI, achievements), but its name becomes `private-project-N` and commit messages, PR/issue titles, descriptions and links are dropped — including in the LLM payload. Default. |
| `skip` | Private activity is excluded from the report and the totals entirely. |

PR/issue search results carry no visibility flag. Visibility comes from the account's full repository list (`/user/repos`, paginated); a repository missing from it — past the last fetched page, or someone else's repository you opened a PR in — is looked up once via `GET /repos/{owner}/{repo}`. The check is fail-closed: if visibility cannot be confirmed (lookup failed, 404/403, over the per-run lookup budget), the repository counts as private, so the worst case is a hidden public PR, never a leaked private one.

Reports contain whatever the policy allows through, so keep the reports repository private unless you have deliberately chosen `redact` or `skip`.

## Configuration

Vars live in `wrangler.jsonc`, which is committed as a **template**: placeholder identifiers
and conservative defaults. Everything except the two identifiers has a working default.

| Var | Default | Meaning |
|---|---|---|
| `GITHUB_USER` | — | GitHub account whose activity is summarized |
| `REPORTS_REPO` | — | `<owner>/<repo>` the reports are committed to |
| `REPORTS_DIR` | `reports` | Directory inside that repo |
| `REPORT_LANG` | `en` | `en` or `ru` — report copy, achievement names and the LLM prompt |
| `REPORT_TITLE` | `Weekly Achievements` | Heading of every report |
| `TIMEZONE` | `UTC` | IANA zone for dates and time-based achievements |
| `CURRENCY` | `EUR` | ISO 4217 code for the salary estimate; changing it triggers a new rates lookup |
| `PRIVATE_REPOS` | `redact` | `full` / `redact` / `skip` (see above) |
| `ENABLE_SALARY_ESTIMATE` | `false` | Price the week's focused hours at market rates found by web search and cached for ~90 days (see [Salary](#salary)) |
| `MAX_REPOS` | `15` | Upper bound on repositories inspected per run |
| `LLM_PROVIDER` | `openai` | `openai` (direct), `vercel` (AI Gateway) or `openrouter` (zero data retention only) |
| `LLM_MODEL` | `gpt-5.6-luna` | `provider/model` for the Gateway and OpenRouter, a bare model name for OpenAI |
| `LLM_REASONING_EFFORT` | `medium` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`provider-default`; a model may collapse these to on/off |

Secrets (`wrangler secret put <NAME>`, or `.dev.vars` locally — see `.dev.vars.example`):

| Secret | What it is |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT: read-only access to the repositories you want scanned |
| `GITHUB_REPORTS_TOKEN` | Fine-grained PAT: reports repository only, Contents read/write |
| `OPENAI_API_KEY` | Needed only with `LLM_PROVIDER=openai` |
| `VERCEL_AI_GATEWAY_API_KEY` | Needed only with `LLM_PROVIDER=vercel` |
| `OPENROUTER_API_KEY` | Needed only with `LLM_PROVIDER=openrouter` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat with the bot (send it `/start`, read the id from `getUpdates`) |
| `RUN_SECRET` | Any string; the bearer token for manual runs |
| `DEV_PROFILE` | Free-form developer profile for the prompt (stack, seniority, region). A secret rather than a var: it is personal data. With the salary estimate on, role/seniority/stack/region are extracted from it for the rates search — the text itself never reaches the search step or KV |

If `DEV_PROFILE` grows past a one-liner, keep it as a gitignored `DEV_PROFILE.md` (Markdown
headings are fine — the prompt reads it as plain text) and run `bun run sync:dev-profile` to
copy it into `.dev.vars` for local dev. It deliberately never touches `wrangler.prod.jsonc` —
`DEV_PROFILE` is a secret, not a var — so push it to the live Worker with:

```bash
bun run secret:dev-profile
```

That's `deploy:prod` followed by `sync-dev-profile.ts --print | wrangler secret put DEV_PROFILE`,
in that order on purpose: Cloudflare refuses to create a secret with the same name as a var
that's still live (`Binding name 'DEV_PROFILE' already in use`), and `deploy:prod` is what clears
a stale var — it replaces the live var set with the current `vars` block, which no longer lists
`DEV_PROFILE`. This is a general Cloudflare rule, not specific to `DEV_PROFILE` — it applies to
any binding moved from `vars` to a secret, or back.

### Your own deployment

The committed `wrangler.jsonc` will not deploy as-is: the worker name is generic and the KV
namespace id is a placeholder. Two ways to make it yours:

- **Private fork** — edit `wrangler.jsonc` in place and use `bun run deploy`.
- **Public fork** — copy it to `wrangler.prod.jsonc` (gitignored), put your real worker name,
  KV namespace id and vars there, and deploy with `bun run deploy:prod`. Your identifiers then
  stay out of the repository, and the template keeps working for everyone else.

`account_id` is deliberately absent from both. Export `CLOUDFLARE_ACCOUNT_ID` locally and add
it as a repository secret if your API token can reach more than one account.

`.github/workflows/ci.yml` runs typecheck + test on every pull request — it's the PR gate,
and the only workflow that fires on `pull_request`. `.github/workflows/deploy.yml` deploys on
every push to `main`, but it never touches vars.
It builds its own config from the committed `wrangler.ci.jsonc` (structural fields only — no
`vars` block, `keep_vars: true`) with your worker name, KV namespace id and queue name
substituted in from small repository secrets, then deploys. Because CI's config carries no vars
and `keep_vars` is set, a code deploy can never overwrite or roll back whatever vars are
currently live on the Worker — those only ever change when you run `bun run deploy:prod`
yourself from your local `wrangler.prod.jsonc`. Run that once after any change to vars (model,
provider, report settings, …); pushing to `main` alone will not pick them up.

Create the queue once (any name) and reuse it in both `wrangler.prod.jsonc` and the
`CF_QUEUE_NAME` secret: `wrangler queues create <your-queue-name>`.

| Repository secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Only if the token can reach several accounts |
| `CF_WORKER_NAME` | Your real worker name (matches `wrangler.prod.jsonc`) |
| `CF_KV_NAMESPACE_ID` | Your real `STATE` KV namespace id |
| `CF_QUEUE_NAME` | Your real `RUN_QUEUE` queue name |

## Running it

```bash
bun install
cp .dev.vars.example .dev.vars   # fill in for local runs
bun run types     # generates worker-configuration.d.ts from wrangler.jsonc
bun run check     # tsc --noEmit
bun run test      # vitest
bun run deploy    # or deploy:prod, see above
```

`scripts/` (maintenance tooling, e.g. `sync-dev-profile.ts`) has its own `scripts/tsconfig.json`
with Bun's ambient types, since `src`/`test` deliberately type-check against the Workers runtime
only — `bun run check:scripts` typechecks that side.

`worker-configuration.d.ts` is generated, not committed — run `bun run types` after
`bun install` and after every change to `wrangler.jsonc`. Typing needs no local file at all:
var types come from `wrangler.jsonc`'s `"vars"`, secret names from its
`"secrets": { "required": [...] }` — that's also what CI runs, with no `.dev.vars` in sight.

Manual run: `curl -H "Authorization: Bearer <RUN_SECRET>" https://<worker-url>/run`, optionally with `?date=YYYY-MM-DD` for the week ending on that date (interpreted at 09:00 local time in `TIMEZONE`). The endpoint answers `202` immediately and hands the run off to the `RUN_QUEUE` queue, which processes it with the same 15-minute budget as the cron trigger — an HTTP-triggered `ctx.waitUntil()` is capped at 30s by Cloudflare, too short for GitHub collection + an LLM call + the report commit.

## State history

State is append-only. Every run writes a new snapshot under `state:<ISO timestamp>` in KV, and
the newest key is the live state. That makes manual runs — trying a different model, provider or
config — reversible: delete the snapshot the run appended and the previous one becomes current
again, so the next run picks up the real streak and totals instead of building on a half-baked
test run.

The loop this is meant for — try a change, look at the report, throw the run away if the change
was wrong:

```bash
export AUTH="Authorization: Bearer <RUN_SECRET>"

curl -H "$AUTH" https://<worker-url>/run          # 202, report lands in the reports repo
                                                  # read it; not happy with the result?
curl -X DELETE -H "$AUTH" https://<worker-url>/state/latest   # drop what that run wrote
# change the code or the vars (model, provider, tone, privacy mode), then:
bun run deploy:prod
curl -H "$AUTH" https://<worker-url>/run          # same week, same starting state, new output
```

Each iteration rewrites the same `reports/YYYY-MM-DD.md` and sends another Telegram message, but
streaks, totals and achievements stay honest — the next real cron run continues from the snapshot
that was live before you started.

```bash
# what the history looks like (oldest first, last entry is live)
curl -H "Authorization: Bearer <RUN_SECRET>" https://<worker-url>/state
```

```json
{
  "current": "state:2026-08-14T08:00:04.512Z",
  "versions": [
    {
      "key": "state:2026-08-07T08:00:03.907Z",
      "meta": { "savedAt": "2026-08-07T08:00:03.907Z", "until": "2026-08-07T08:00:00.000Z", "reportCount": 12, "streak": 5 }
    },
    {
      "key": "state:2026-08-14T08:00:04.512Z",
      "meta": { "savedAt": "2026-08-14T08:00:04.512Z", "until": "2026-08-14T08:00:00.000Z", "reportCount": 13, "streak": 6 }
    }
  ]
}
```

```bash
# undo the newest run
curl -X DELETE -H "Authorization: Bearer <RUN_SECRET>" https://<worker-url>/state/latest
```

```json
{ "deleted": "state:2026-08-14T08:00:04.512Z" }
```

With no snapshots left to delete the answer is `404` with `{ "error": "no state snapshots" }`.
Both endpoints use the same bearer token as `/run`. The listing is served from KV metadata
(`savedAt`, `until`, `reportCount`, `streak`), so it costs one `list` call. `run_done` in the
Workers logs carries the `stateKey` the run wrote, if you would rather delete it with
`wrangler kv key delete --binding STATE '<key>'`.

Notes:

- The last 52 snapshots are kept; older ones are pruned on write.
- KV reads are eventually consistent (up to ~60s), so leave a few seconds between deleting a
  snapshot and re-running.
- With no snapshots at all, the pre-versioning `state` key is read once as a fallback; after
  that the versioned snapshots always win.

## Known limitations

- Commit messages and issue titles written by other people end up in the prompt, so the usual prompt-injection caveats apply. The blast radius is limited to the wording of your own report — the report model has no tools and no write access. The rates lookup has a read-only web search tool; a poisoned search result can at worst skew the cached rates (see [SECURITY.md](SECURITY.md)).
- Only default-branch commits authored by `GITHUB_USER` are counted, up to 100 per repository per run; merge commits are fetched but excluded.
- Focused hours come from commits only — code review, writing issues and meetings are invisible to them.
- CI and deployment stats are fetched for at most 10 repositories per run (Workers subrequest budget).
- Missed runs are caught up from the last successful one, but never more than 4 weeks back.

## Security

What the worker is trusted with, what deliberately never reaches the model, and how to report
a problem privately: [SECURITY.md](SECURITY.md).

## License

MIT
