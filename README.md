# Weekly GitHub Achievements

A Cloudflare Worker that turns a week of your GitHub activity into a report you actually want to read.

Once a week it scans every repository you touched — commits, pull requests, issues, CI runs, deployments — asks an LLM to describe what was accomplished (per project, in plain language, plus an optional "what this week was worth on the market" estimate), commits the markdown to a reports repository and sends a short summary to Telegram. Streaks and achievements are tracked across runs in Workers KV.

It was built as a personal "wall of fame" for a developer who tends to undervalue their own work. Everything personal about it — the profile, the language, the currency, the time zone, the tone — is configuration.

## How it works

```
cron (weekly)
  └─ collect GitHub activity (REST + GraphQL)
       └─ apply privacy policy for private repos
            └─ sanitize → LLM (OpenAI or Vercel AI Gateway)
                 └─ build markdown → commit to reports repo
                      └─ Telegram notification
                           └─ persist streak / totals / achievements in KV
```

- **Cloudflare Worker** with a cron trigger, plus authenticated `/run` and `/state` endpoints for manual runs and rolling them back
- **GitHub API**: REST (repo list, PR/issue search, committing the report) and GraphQL (commits with per-commit stats in a single request)
- **LLM**: OpenAI Responses API directly, or the same models through the Vercel AI Gateway (`@ai-sdk/gateway` + `ai`) — switched with `LLM_PROVIDER`. Structured output either way
- **Workers KV**: streak, all-time totals, unlocked achievements, previous-week snapshot — appended as a new snapshot per run, so a test run can be rolled back (see [State history](#state-history))
- **Telegram Bot API**: outbound `sendMessage` only, no webhook

## Modules

```
src/index.ts        — scheduled handler + fetch (manual /run)
src/run.ts          — weekly run orchestrator
src/config.ts       — env → validated config with defaults
src/github.ts       — activity collection + committing the report
src/privacy.ts      — private repository policy (full / redact / skip)
src/sanitize.ts     — data guard for everything sent to the LLM
src/llm.ts          — prompt and model call
src/report.ts       — markdown assembly
src/telegram.ts     — notifications
src/state.ts        — KV-backed state (append-only snapshot history)
src/achievements.ts — achievement rules
src/i18n/           — all user-facing copy (en, ru)
src/time.ts         — time-zone-aware date helpers
```

## What reaches the LLM

The GitHub token can read code, but the application never asks for any: it only reads commit headlines, line counters, PR/issue titles, languages, and CI/deployment statistics. Before a request is made, the payload goes through `src/sanitize.ts`:

- a single exit point — the payload is an explicit projection over an allowlist of fields;
- every key of the finished payload is checked recursively, fail-closed: an unknown key raises an error instead of being sent;
- text fields are clipped to 200 characters.

File contents, diffs and patches cannot get there by construction. The same payload and the same path are used for both LLM providers.

## Private repositories

`PRIVATE_REPOS` decides what happens to repositories GitHub marks private:

| Mode | Effect |
|---|---|
| `full` | Names, commit messages and links appear in the report as-is. Only sensible if the reports repository is private. |
| `redact` | The repository is still counted (commits, lines, CI, achievements), but its name becomes `private-project-N` and commit messages, titles and links are dropped — including in the LLM payload. Default. |
| `skip` | Private activity is excluded from the report and the totals entirely. |

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
| `CURRENCY` | `EUR` | ISO 4217 code for the salary estimate |
| `PRIVATE_REPOS` | `redact` | `full` / `redact` / `skip` (see above) |
| `ENABLE_SALARY_ESTIMATE` | `false` | Ask the model what the week would be worth on the market |
| `MAX_REPOS` | `15` | Upper bound on repositories inspected per run |
| `LLM_PROVIDER` | `openai` | `openai` (direct) or `vercel` (AI Gateway) |
| `LLM_MODEL` | `gpt-5.6-luna` | `provider/model` for the Gateway, a bare model name for OpenAI |
| `LLM_REASONING_EFFORT` | `medium` | `none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`provider-default`; a model may collapse these to on/off |

Secrets (`wrangler secret put <NAME>`, or `.dev.vars` locally — see `.dev.vars.example`):

| Secret | What it is |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT: read-only access to the repositories you want scanned |
| `GITHUB_REPORTS_TOKEN` | Fine-grained PAT: reports repository only, Contents read/write |
| `OPENAI_API_KEY` | Needed only with `LLM_PROVIDER=openai` |
| `VERCEL_AI_GATEWAY_API_KEY` | Needed only with `LLM_PROVIDER=vercel` |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Your chat with the bot (send it `/start`, read the id from `getUpdates`) |
| `RUN_SECRET` | Any string; the bearer token for manual runs |
| `DEV_PROFILE` | Free-form developer profile for the prompt (stack, seniority, region). A secret rather than a var: it is personal data and it drives the salary estimate |

### Your own deployment

The committed `wrangler.jsonc` will not deploy as-is: the worker name is generic and the KV
namespace id is a placeholder. Two ways to make it yours:

- **Private fork** — edit `wrangler.jsonc` in place and use `bun run deploy`.
- **Public fork** — copy it to `wrangler.prod.jsonc` (gitignored), put your real worker name,
  KV namespace id and vars there, and deploy with `bun run deploy:prod`. Your identifiers then
  stay out of the repository, and the template keeps working for everyone else.

`account_id` is deliberately absent from both. Export `CLOUDFLARE_ACCOUNT_ID` locally and add
it as a repository secret if your API token can reach more than one account.

`.github/workflows/deploy.yml` deploys on every push to `main`, but it never touches vars.
It builds its own config from the committed `wrangler.ci.jsonc` (structural fields only — no
`vars` block, `keep_vars: true`) with your worker name and KV namespace id substituted in from
two small repository secrets, then deploys. Because CI's config carries no vars and `keep_vars`
is set, a code deploy can never overwrite or roll back whatever vars are currently live on the
Worker — those only ever change when you run `bun run deploy:prod` yourself from your local
`wrangler.prod.jsonc`. Run that once after any change to vars (model, provider, report settings,
…); pushing to `main` alone will not pick them up.

| Repository secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API token with Workers deploy permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Only if the token can reach several accounts |
| `CF_WORKER_NAME` | Your real worker name (matches `wrangler.prod.jsonc`) |
| `CF_KV_NAMESPACE_ID` | Your real `STATE` KV namespace id |

## Running it

```bash
bun install
cp .dev.vars.example .dev.vars   # fill in for local runs
bun run types     # generates worker-configuration.d.ts from wrangler.jsonc + .dev.vars
bun run check     # tsc --noEmit
bun run test      # vitest
bun run deploy    # or deploy:prod, see above
```

`worker-configuration.d.ts` is generated, not committed — run `bun run types` after
`bun install` and after every change to `wrangler.jsonc` or `.dev.vars`. Only the *keys* of
`.dev.vars` matter for typing, so `.dev.vars.example` is enough to typecheck (that is what CI
copies).

Manual run: `curl -H "Authorization: Bearer <RUN_SECRET>" https://<worker-url>/run`, optionally with `?date=YYYY-MM-DD` for the week ending on that date (interpreted at 09:00 local time in `TIMEZONE`). The endpoint answers `202` immediately and finishes the run in the background.

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

- Commit messages and issue titles written by other people end up in the prompt, so the usual prompt-injection caveats apply. The blast radius is limited to the wording of your own report — the model has no tools and no write access.
- Only default-branch commits authored by `GITHUB_USER` are counted, up to 100 per repository per run.
- CI and deployment stats are fetched for at most 10 repositories per run (Workers subrequest budget).
- Missed runs are caught up from the last successful one, but never more than 4 weeks back.

## Security

What the worker is trusted with, what deliberately never reaches the model, and how to report
a problem privately: [SECURITY.md](SECURITY.md).

## License

MIT
