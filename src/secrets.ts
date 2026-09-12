/**
 * Secret scrubbing for free text bound for the LLM (commit messages, PR/issue titles
 * and descriptions).
 *
 * - scrubSecrets() replaces secret-like substrings with SECRET_PLACEHOLDER;
 * - assertNoSecrets() re-scans every string of a finished payload and throws if any rule
 *   still matches (fail-closed) — e.g. a text field added to the payload later without
 *   going through scrubSecrets() blocks the LLM call instead of leaking.
 *
 * Heuristic by nature: known credential formats plus a generic high-entropy fallback,
 * tuned to leave ordinary commit text alone — short and full (40-char) git SHAs, UUIDs,
 * paths, identifiers, branch names.
 */

export const SECRET_PLACEHOLDER = "[secret]";

interface Rule {
  name: string;
  /** Must carry the g flag: used by both replace() and matchAll(). */
  re: RegExp;
  /** Extra check on a candidate; without it every match counts as a secret. */
  accept?: (match: string) => boolean;
}

/** Share of characters that sit in lowercase runs of 4+ — words, as opposed to random noise. */
function wordiness(s: string): number {
  return (s.match(/[a-z]{4,}/g) ?? []).reduce((n, w) => n + w.length, 0) / s.length;
}

/**
 * Random base64/base62 tokens mix all three character classes, rarely form words and
 * contain few separators; identifiers, paths and branch names fail at least one of these.
 */
function looksRandom(s: string): boolean {
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/\d/.test(s)) return false;
  const separators = (s.match(/[\/+=_-]/g) ?? []).length;
  return wordiness(s) < 0.35 && separators / s.length <= 0.15;
}

const RULES: Rule[] = [
  // PEM private key blocks; a block cut off before its END line is scrubbed to the end of the text.
  {
    name: "private-key",
    re: /-----BEGIN[A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(?:-----END[A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----|$)/g,
  },
  // scheme://user:password@host — only the userinfo is replaced, the host stays for context.
  { name: "url-credentials", re: /(?<=[a-z][a-z0-9+.-]*:\/\/)[^\s\/?#@:]+:[^\s\/?#]+(?=@)/gi },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  // OpenAI/Anthropic-style sk-… keys; the digit requirement spares kebab-case words like "sk-learn-…".
  { name: "sk-key", re: /\bsk-[A-Za-z0-9_-]{20,}/g, accept: (m) => /\d/.test(m) },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "telegram-bot-token", re: /\d{6,}:[A-Za-z0-9_-]{30,}/g },
  // Bearer <token>: keeps the word "Bearer"; a plain lowercase word after it is prose, not a token.
  {
    name: "bearer-token",
    re: /(?<=\bBearer\s+)[A-Za-z0-9._~+\/=-]{16,}/gi,
    accept: (m) => /[0-9._~+\/=]/.test(m) || (/[A-Z]/.test(m) && /[a-z]/.test(m)),
  },
  // Long hex runs (API keys, SHA-256 secrets). Exactly 40 chars is a full git SHA-1 — kept.
  {
    name: "hex-run",
    re: /\b[0-9a-fA-F]{32,}\b/g,
    accept: (m) => m.length !== 40 && /\d/.test(m) && /[a-fA-F]/.test(m),
  },
  { name: "high-entropy-run", re: /[A-Za-z0-9+\/=_-]{32,}/g, accept: looksRandom },
];

export function scrubSecrets(text: string): string {
  return RULES.reduce(
    (s, rule) => s.replace(rule.re, (m) => (!rule.accept || rule.accept(m) ? SECRET_PLACEHOLDER : m)),
    text,
  );
}

/** Name of the first rule that still matches, or null. */
export function findSecret(text: string): string | null {
  for (const rule of RULES) {
    for (const [m] of text.matchAll(rule.re)) {
      if (!rule.accept || rule.accept(m)) return rule.name;
    }
  }
  return null;
}

/** Walks every string of the value; throws (without echoing the match) on anything secret-like. */
export function assertNoSecrets(value: unknown, path = "$"): void {
  if (typeof value === "string") {
    const rule = findSecret(value);
    if (rule) {
      throw new Error(`LLM payload guard: secret-like text (${rule}) at ${path} — the LLM call was blocked`);
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
    return;
  }
  for (const [key, v] of Object.entries(value)) assertNoSecrets(v, `${path}.${key}`);
}
