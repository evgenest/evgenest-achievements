import { getMessages, isLang, type Lang, type Messages } from "./i18n";

/**
 * How repositories marked private on GitHub are treated:
 * - `full`   — names, commit messages and links appear in the report as-is;
 * - `redact` — the repository is counted, but its name is replaced with a
 *              placeholder and commit messages, titles and links are dropped;
 * - `skip`   — private activity is excluded from the report entirely.
 */
export type PrivacyMode = "full" | "redact" | "skip";

export type LlmProvider = "openai" | "vercel";

/** Reasoning levels understood by the AI SDK; a model may collapse them to on/off. */
const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "provider-default"] as const;
export type ReasoningEffort = (typeof REASONING_LEVELS)[number];

export interface Config {
  githubUser: string;
  reportsRepo: string;
  reportsDir: string;
  lang: Lang;
  messages: Messages;
  timezone: string;
  currency: string;
  reportTitle: string;
  devProfile: string;
  salaryEstimate: boolean;
  privacy: PrivacyMode;
  maxRepos: number;
  llm: { provider: LlmProvider; model: string; reasoningEffort: ReasoningEffort };
}

const DEFAULTS = {
  reportsDir: "reports",
  lang: "en" as Lang,
  timezone: "UTC",
  currency: "EUR",
  reportTitle: "Weekly Achievements",
  devProfile: "Software developer.",
  privacy: "redact" as PrivacyMode,
  maxRepos: 15,
  model: "gpt-5.6-luna",
  reasoningEffort: "medium" as ReasoningEffort,
};

function str(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return fallback;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function reasoningEffort(value: string | undefined): ReasoningEffort {
  const v = value?.trim().toLowerCase() as ReasoningEffort | undefined;
  return v && REASONING_LEVELS.includes(v) ? v : DEFAULTS.reasoningEffort;
}

function privacyMode(value: string | undefined): PrivacyMode {
  const v = value?.trim().toLowerCase();
  return v === "full" || v === "redact" || v === "skip" ? v : DEFAULTS.privacy;
}

/** Reads env into a validated config. Everything except identifiers has a safe default. */
export function loadConfig(env: Env): Config {
  const langVar = str(env.REPORT_LANG, DEFAULTS.lang);
  const lang = isLang(langVar) ? langVar : DEFAULTS.lang;

  return {
    githubUser: str(env.GITHUB_USER, ""),
    reportsRepo: str(env.REPORTS_REPO, ""),
    reportsDir: str(env.REPORTS_DIR, DEFAULTS.reportsDir).replace(/^\/+|\/+$/g, ""),
    lang,
    messages: getMessages(lang),
    timezone: str(env.TIMEZONE, DEFAULTS.timezone),
    currency: str(env.CURRENCY, DEFAULTS.currency),
    reportTitle: str(env.REPORT_TITLE, DEFAULTS.reportTitle),
    devProfile: str(env.DEV_PROFILE, DEFAULTS.devProfile),
    salaryEstimate: bool(env.ENABLE_SALARY_ESTIMATE, false),
    privacy: privacyMode(env.PRIVATE_REPOS),
    maxRepos: int(env.MAX_REPOS, DEFAULTS.maxRepos),
    llm: {
      provider: str(env.LLM_PROVIDER, "openai") === "vercel" ? "vercel" : "openai",
      model: str(env.LLM_MODEL, DEFAULTS.model),
      reasoningEffort: reasoningEffort(env.LLM_REASONING_EFFORT),
    },
  };
}
