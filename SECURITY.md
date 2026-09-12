# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting instead: **Security → Report a vulnerability** on this
repository. Expect a first reply within a few days; this is a spare-time project, not a
product with an on-call rotation.

## What this project handles

The worker is deployed by each user into their own Cloudflare account, with their own
credentials. There is no hosted service and no shared infrastructure — a vulnerability
here affects whoever runs their own copy.

Credentials it is given (all as Workers secrets, never as vars):

| Secret | Blast radius if leaked |
|---|---|
| `GITHUB_TOKEN` | Read access to the repositories you scoped the PAT to |
| `GITHUB_REPORTS_TOKEN` | Write access to the reports repository only |
| `OPENAI_API_KEY` / `VERCEL_AI_GATEWAY_API_KEY` | LLM spend on your account |
| `TELEGRAM_BOT_TOKEN` | Control of the notification bot |
| `RUN_SECRET` | Ability to trigger extra runs (cost, no data exfiltration), to list the state history (counters only) and to delete its newest snapshot |
| `DEV_PROFILE` | Personal data in the prompt (career history, stack, clients, income) — see README. Only its SHA-256 is stored in KV (to notice edits), never the text |

Use fine-grained PATs and split them as the README describes: the scanning token needs
no write access anywhere, and the reports token needs no access outside the reports
repository.

## Design decisions that are part of the threat model

- **Nothing but metadata reaches the LLM.** `src/sanitize.ts` is a single exit point that
  builds the payload as an explicit projection over an allowlist, then re-validates every
  key of the finished object recursively and throws on anything unknown. File contents,
  diffs and patches cannot reach the model by construction; commit timestamps don't either
  (only minutes between commits). Redacted private repositories contribute line counters
  and those time windows per commit, never names or text. Changes to that file deserve
  extra scrutiny.
- **Prompt injection is accepted, not solved.** Commit messages, PR and issue titles
  written by other people end up in the prompt. The report model has no tools and no write
  access, so the worst case is misleading wording in your own report. Do not extend the
  model's capabilities without revisiting this.
- **The market-rate lookup is the one call with a tool, and it is boxed in.** Only with
  `ENABLE_SALARY_ESTIMATE=true` and only when the cached rates are stale, a call gets a
  provider-executed, read-only web search tool (OpenAI web search, or Perplexity search run
  by the Vercel AI Gateway). It never sees commit data or the `DEV_PROFILE` text — a separate
  tool-less call first extracts role, seniority, stack, region and country code, and only
  that extract is passed on; search queries (which the search provider receives) are built
  from it. The answer is structured output: two positive numbers, a region label and links,
  and a link is kept only if the search really returned it; titles are stripped of markdown
  before landing in the report. A poisoned search result can at worst skew the cached rates
  for up to 90 days — `DELETE /state/latest` (or a `DEV_PROFILE`/`CURRENCY` change) forces a
  new lookup.
- **Only a hash of `DEV_PROFILE` is stored.** The rates cache keeps an unsalted SHA-256 of the
  profile to notice edits. For a very short, guessable profile someone with KV access could
  confirm a guess; the text itself is never written anywhere.
- **Errors are not echoed outward.** Failure details go to Workers logs (which require
  Cloudflare account access); Telegram gets a fixed sanitized notice. LLM debugging logs
  record the *shape* of the answer, not its content.
- **Every endpoint is authenticated** with a constant-time comparison of a bearer token
  against `RUN_SECRET`, and returns `403` for anything else. Every other path is `404`.
  `GET /state` exposes snapshot keys and counters (report count, streak, period end) —
  no repository names, titles or links; `DELETE /state/latest` removes one snapshot, and
  the run history is capped at 52 snapshots, so the worst case is a distorted streak.
- **`PRIVATE_REPOS` is a privacy control, not a security boundary.** With `full`, reports
  contain private repository names and commit titles — the reports repository must then be
  private. `redact` is the default for that reason.
- **CI cannot see or change vars/secrets, structurally.** `.github/workflows/deploy.yml` deploys
  with `wrangler.ci.jsonc`, which carries no `vars` block and sets `keep_vars: true` — Cloudflare
  then leaves whatever is already live untouched. Vars and secrets only ever change from your own
  machine (`bun run deploy:prod`, `wrangler secret put`). A compromised CI run, or a leaked
  `CLOUDFLARE_API_TOKEN` with only deploy scope, cannot read or roll back `DEV_PROFILE` or any
  other var/secret this way.

## Out of scope

- The contents of your reports repository, and who you grant access to it.
- Anything reachable with your own Cloudflare, GitHub, OpenAI or Telegram credentials.
- Prompt-injection-driven changes to report wording (see above).
