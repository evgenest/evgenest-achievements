import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, type LanguageModel, Output, type ToolSet } from "ai";
import { z } from "zod";
import type { Config } from "./config";
import { openRouterZdr } from "./openrouter";
import { EXTRACT_INSTRUCTIONS, knowledgeInstructions, marketPrompt, searchInstructions } from "./rates-prompt";
import type { RateSource } from "./types";

/**
 * Market-rate lookup — runs only when the cached rates are stale (see rates.ts).
 *
 * 1. extract: DEV_PROFILE → { role, seniority, stack, region, countryCode }, no tools.
 *    This is the only call that sees the profile text.
 * 2. search: that extract (never the profile itself) + a provider-executed web search
 *    tool → rates + source URLs. Provider-executed tools run inside a single model step
 *    (ai@7 only loops for client-side tools), so structured output needs no stopWhen.
 * 3. fallback: when search fails or isn't supported, the same question without tools —
 *    the model's own knowledge, reported with no sources (and cached briefly).
 */

export interface MarketProfile {
  role: string;
  seniority: string;
  stack: string[];
  region: string;
  countryCode?: string;
}

export interface RatesLookup {
  annualGross: number;
  freelanceHourly: number;
  region: string;
  sources: RateSource[];
}

const PROFILE_SCHEMA = z.strictObject({
  role: z.string(),
  seniority: z.string(),
  stack: z.array(z.string()),
  region: z.string(),
  countryCode: z.string(),
});

const AMOUNTS_SHAPE = { annualGross: z.number(), freelanceHourly: z.number(), region: z.string() };
const SEARCH_SCHEMA = z.strictObject({
  ...AMOUNTS_SHAPE,
  sources: z.array(z.strictObject({ title: z.string(), url: z.string() })),
});
const KNOWLEDGE_SCHEMA = z.strictObject(AMOUNTS_SHAPE);

const MAX_SOURCES = 5;

function clean(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) : t;
}

/** Text that lands in the markdown report: no characters that could open links or emphasis. */
const plain = (s: string): string => s.replace(/[[\]()|`*_<>]/g, " ");

function cleanProfile(raw: z.infer<typeof PROFILE_SCHEMA>): MarketProfile {
  const code = raw.countryCode.trim().toUpperCase();
  return {
    role: clean(raw.role, 80) || "Software developer",
    seniority: clean(raw.seniority, 40),
    stack: raw.stack.map((s) => clean(s, 40)).filter(Boolean).slice(0, 8),
    region: clean(raw.region, 80),
    ...(/^[A-Z]{2}$/.test(code) ? { countryCode: code } : {}),
  };
}

/** http(s) only; title stripped of markdown-breaking characters; parentheses in the URL encoded. */
function cleanSource(title: unknown, url: unknown): RateSource | null {
  if (typeof url !== "string") return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const text = clean(typeof title === "string" ? plain(title) : "", 80);
  // encodeURIComponent leaves parentheses alone, and a ")" would end the markdown link early.
  return { title: text || u.hostname, url: u.href.replaceAll("(", "%28").replaceAll(")", "%29") };
}

const urlKey = (url: string): string => {
  const u = new URL(url);
  return `${u.hostname.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}`;
};

/** Every URL the search actually returned: SDK sources plus anything url-shaped in tool results. */
function collectUrls(value: unknown, out: Map<string, RateSource>, depth = 0): void {
  if (depth > 6 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectUrls(v, out, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  const source = cleanSource(obj.title, obj.url);
  if (source && !out.has(urlKey(source.url))) out.set(urlKey(source.url), source);
  for (const v of Object.values(obj)) collectUrls(v, out, depth + 1);
}

/** Keep only cited pages the search really returned; if the model cited none of them, list what it found. */
function groundSources(cited: { title: string; url: string }[], seen: Map<string, RateSource>): RateSource[] {
  const kept = new Map<string, RateSource>();
  for (const c of cited) {
    const source = cleanSource(c.title, c.url);
    if (!source) continue;
    const key = urlKey(source.url);
    if (seen.size === 0 || seen.has(key)) kept.set(key, source);
  }
  const list = kept.size > 0 ? [...kept.values()] : [...seen.values()].slice(0, 3);
  return list.slice(0, MAX_SOURCES);
}

function checkAmounts(o: { annualGross: number; freelanceHourly: number; region: string }, fallbackRegion: string) {
  const ok = (n: number) => Number.isFinite(n) && n > 0;
  if (!ok(o.annualGross) || !ok(o.freelanceHourly)) throw new Error("rates lookup: amounts must be positive numbers");
  return {
    annualGross: o.annualGross,
    freelanceHourly: o.freelanceHourly,
    region: clean(plain(o.region), 80) || clean(plain(fallbackRegion), 80) || "—",
  };
}

interface Providers {
  model: LanguageModel;
  searchTools: (countryCode?: string) => ToolSet;
}

function providers(env: Env, config: Config): Providers {
  if (config.llm.provider === "vercel") {
    const gateway = createGateway({ apiKey: env.VERCEL_AI_GATEWAY_API_KEY });
    return {
      model: gateway(config.llm.model),
      // Executed by the Gateway itself, so it works with any model routed through it.
      searchTools: (country) => ({ perplexity_search: gateway.tools.perplexitySearch({ maxResults: 10, ...(country && { country }) }) }),
    };
  }
  if (config.llm.provider === "openrouter") {
    const { model, tools } = openRouterZdr(env, config);
    return {
      model,
      // Executed by OpenRouter: the model's native search where it has one, Exa otherwise.
      // Outside ZDR, but the queries are built from the extract only. No country option here,
      // and no maxResults: provider v3.0.0 sends it outside the `parameters` object the API reads.
      searchTools: () => ({ web_search: tools.webSearch({}) }),
    };
  }
  const openai = createOpenAI({ apiKey: env.OPENAI_API_KEY });
  return {
    model: openai(config.llm.model),
    searchTools: (country) => ({
      web_search: openai.tools.webSearch(country ? { userLocation: { type: "approximate", country } } : {}),
    }),
  };
}

async function extractProfile(model: LanguageModel, config: Config): Promise<MarketProfile> {
  const { output } = await generateText({
    model,
    instructions: EXTRACT_INSTRUCTIONS,
    prompt: `Developer profile:\n${config.devProfile}`,
    reasoning: config.llm.reasoningEffort,
    output: Output.object({ schema: PROFILE_SCHEMA }),
  });
  return cleanProfile(output);
}

export async function lookupMarketRates(env: Env, config: Config, now: Date = new Date()): Promise<RatesLookup> {
  const { model, searchTools } = providers(env, config);
  const profile = await extractProfile(model, config);
  const ctx = { currency: config.currency, languageName: config.messages.languageName, today: now.toISOString().slice(0, 10) };
  const prompt = marketPrompt(profile);

  try {
    const tools = searchTools(profile.countryCode);
    const result = await generateText({
      model,
      tools,
      instructions: searchInstructions(ctx),
      prompt,
      reasoning: config.llm.reasoningEffort,
      output: Output.object({ schema: SEARCH_SCHEMA }),
    });
    const amounts = checkAmounts(result.output, profile.region);
    const seen = new Map<string, RateSource>();
    collectUrls(result.sources, seen);
    collectUrls(result.toolResults.map((r) => r.output), seen);
    const searched = seen.size > 0 || result.toolCalls.some((c) => c.toolName in tools);
    // Tools offered but never called: the numbers are model knowledge, whatever it cites.
    return { ...amounts, sources: searched ? groundSources(result.output.sources, seen) : [] };
  } catch (err) {
    console.error(
      JSON.stringify({ event: "rates_search_failed", provider: config.llm.provider, model: config.llm.model, error: String(err).slice(0, 300) }),
    );
  }

  const { output } = await generateText({
    model,
    instructions: knowledgeInstructions(ctx),
    prompt,
    reasoning: config.llm.reasoningEffort,
    output: Output.object({ schema: KNOWLEDGE_SCHEMA }),
  });
  return { ...checkAmounts(output, profile.region), sources: [] };
}
