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

- **Cloudflare Worker** with a cron trigger, plus an authenticated `/run` endpoint for manual runs
- **GitHub API**: REST (repo list, PR/issue search, committing the report) and GraphQL (commits with per-commit stats in a single request)
- **LLM**: OpenAI Responses API directly, or the same models through the Vercel AI Gateway (`@ai-sdk/gateway` + `ai`) — switched with `LLM_PROVIDER`. Structured output either way
- **Workers KV**: streak, all-time totals, unlocked achievements, previous-week snapshot
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
src/state.ts        — KV-backed state
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

Vars live in `wrangler.jsonc`. Everything except the two identifiers has a working default.

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
| `LLM_MODEL` | — | `provider/model` for the Gateway, a bare model name for OpenAI |
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

`account_id` is deliberately absent from `wrangler.jsonc`. Export `CLOUDFLARE_ACCOUNT_ID` locally and add it as a repository secret if your API token can reach more than one account. The KV namespace id in the config is the author's — create your own with `wrangler kv namespace create STATE` and replace it.

## Running it

```bash
bun install
bun run types     # generates worker-configuration.d.ts from wrangler.jsonc + .dev.vars
bun run check     # tsc --noEmit
bun run test      # vitest
bun run deploy
```

Manual run: `curl -H "Authorization: Bearer <RUN_SECRET>" https://<worker-url>/run`, optionally with `?date=YYYY-MM-DD` for the week ending on that date (interpreted at 09:00 local time in `TIMEZONE`). The endpoint answers `202` immediately and finishes the run in the background.

## Known limitations

- Commit messages and issue titles written by other people end up in the prompt, so the usual prompt-injection caveats apply. The blast radius is limited to the wording of your own report — the model has no tools and no write access.
- Only default-branch commits authored by `GITHUB_USER` are counted, up to 100 per repository per run.
- CI and deployment stats are fetched for at most 10 repositories per run (Workers subrequest budget).
- Missed runs are caught up from the last successful one, but never more than 4 weeks back.

## License

MIT
