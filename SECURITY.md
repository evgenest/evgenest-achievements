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
| `DEV_PROFILE` | Personal data in the prompt (stack, seniority, region) |

Use fine-grained PATs and split them as the README describes: the scanning token needs
no write access anywhere, and the reports token needs no access outside the reports
repository.

## Design decisions that are part of the threat model

- **Nothing but metadata reaches the LLM.** `src/sanitize.ts` is a single exit point that
  builds the payload as an explicit projection over an allowlist, then re-validates every
  key of the finished object recursively and throws on anything unknown. File contents,
  diffs and patches cannot reach the model by construction. Changes to that file deserve
  extra scrutiny.
- **Prompt injection is accepted, not solved.** Commit messages, PR and issue titles
  written by other people end up in the prompt. The model has no tools and no write
  access, so the worst case is misleading wording in your own report. Do not extend the
  model's capabilities without revisiting this.
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

## Out of scope

- The contents of your reports repository, and who you grant access to it.
- Anything reachable with your own Cloudflare, GitHub, OpenAI or Telegram credentials.
- Prompt-injection-driven changes to report wording (see above).
