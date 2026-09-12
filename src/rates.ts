import type { Config } from "./config";
import { lookupMarketRates, type RatesLookup } from "./rates-lookup";
import type { MarketRates } from "./types";

/**
 * Market rates are looked up rarely and cached in the KV state, so the salary math uses
 * the same rates week after week and the amounts stay comparable.
 */

/** Rates backed by web-search sources are reused this long. */
export const RATES_TTL_DAYS = 90;
/** A model-knowledge estimate (no sources) is reused only briefly, so a real search is retried soon. */
export const RATES_UNSOURCED_TTL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Hex SHA-256 of DEV_PROFILE: detects profile edits without ever storing the text. */
export async function profileHash(profile: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(profile));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sameCurrency = (a: string, b: string): boolean => a.trim().toUpperCase() === b.trim().toUpperCase();

export type StaleReason = "missing" | "expired" | "profile" | "currency";

/** Why the cached rates can't be reused, or null when they can. */
export function staleReason(
  cached: MarketRates | null | undefined,
  hash: string,
  currency: string,
  now: Date,
): StaleReason | null {
  if (!cached) return "missing";
  if (!sameCurrency(cached.currency, currency)) return "currency";
  if (cached.profileHash !== hash) return "profile";
  const ttlDays = cached.sources.length > 0 ? RATES_TTL_DAYS : RATES_UNSOURCED_TTL_DAYS;
  const age = now.getTime() - Date.parse(cached.fetchedAt);
  return Number.isFinite(age) && age < ttlDays * DAY_MS ? null : "expired";
}

export type RatesLookupFn = (env: Env, config: Config) => Promise<RatesLookup>;

/**
 * Cached rates when still valid, otherwise a fresh lookup. Never throws: when the lookup
 * fails, stale rates are reused (same currency only — otherwise every amount would carry
 * the wrong symbol), and with nothing to reuse the salary section is simply left out.
 */
export async function resolveRates(
  env: Env,
  config: Config,
  cached: MarketRates | null | undefined,
  now: Date = new Date(),
  lookup: RatesLookupFn = lookupMarketRates,
): Promise<MarketRates | null> {
  try {
    const hash = await profileHash(config.devProfile);
    const reason = staleReason(cached, hash, config.currency, now);
    if (reason === null && cached) return cached;

    const found = await lookup(env, config);
    console.log(JSON.stringify({ event: "rates_refreshed", reason, sources: found.sources.length }));
    return { ...found, currency: config.currency, fetchedAt: now.toISOString(), profileHash: hash };
  } catch (err) {
    console.error(JSON.stringify({ event: "rates_lookup_failed", error: String(err).slice(0, 300) }));
    return cached && sameCurrency(cached.currency, config.currency) ? cached : null;
  }
}
