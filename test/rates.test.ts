import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileHash, RATES_TTL_DAYS, RATES_UNSOURCED_TTL_DAYS, resolveRates, staleReason } from "../src/rates";
import type { RatesLookup } from "../src/rates-lookup";
import { makeConfig, makeRates } from "./fixtures";

const DAY = 24 * 60 * 60 * 1000;
const fetchedAt = "2026-08-01T08:00:00.000Z";
const daysLater = (d: number) => new Date(Date.parse(fetchedAt) + d * DAY);
const env = {} as Env;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("profileHash", () => {
  it("is a hex SHA-256 that never contains the profile text", async () => {
    const hash = await profileHash("Senior dev in Berlin");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(await profileHash("Senior dev in Berlin"));
    expect(hash).not.toBe(await profileHash("Senior dev in Munich"));
  });
});

describe("staleReason", () => {
  const hash = "0".repeat(64);

  it("reports a missing cache", () => {
    expect(staleReason(null, hash, "EUR", daysLater(1))).toBe("missing");
    expect(staleReason(undefined, hash, "EUR", daysLater(1))).toBe("missing");
  });

  it("reuses searched rates until the TTL runs out", () => {
    const rates = makeRates({ fetchedAt, profileHash: hash });
    expect(staleReason(rates, hash, "EUR", daysLater(RATES_TTL_DAYS - 1))).toBeNull();
    expect(staleReason(rates, hash, "EUR", daysLater(RATES_TTL_DAYS))).toBe("expired");
  });

  it("gives unsourced (model-knowledge) rates a short TTL", () => {
    const rates = makeRates({ fetchedAt, profileHash: hash, sources: [] });
    expect(staleReason(rates, hash, "EUR", daysLater(RATES_UNSOURCED_TTL_DAYS - 1))).toBeNull();
    expect(staleReason(rates, hash, "EUR", daysLater(RATES_UNSOURCED_TTL_DAYS))).toBe("expired");
  });

  it("refreshes when the profile changes", () => {
    expect(staleReason(makeRates({ fetchedAt, profileHash: hash }), "f".repeat(64), "EUR", daysLater(1))).toBe("profile");
  });

  it("refreshes when the currency changes (case-insensitive)", () => {
    const rates = makeRates({ fetchedAt, profileHash: hash });
    expect(staleReason(rates, hash, "USD", daysLater(1))).toBe("currency");
    expect(staleReason(rates, hash, "eur", daysLater(1))).toBeNull();
  });

  it("treats an unreadable fetch date as expired", () => {
    expect(staleReason(makeRates({ fetchedAt: "garbage", profileHash: hash }), hash, "EUR", daysLater(1))).toBe("expired");
  });
});

describe("resolveRates", () => {
  const config = makeConfig(); // DEV_PROFILE "Test developer.", CURRENCY EUR
  const found: RatesLookup = {
    annualGross: 70_000,
    freelanceHourly: 90,
    region: "Germany",
    sources: [{ title: "Jobs", url: "https://jobs.example/x" }],
  };
  const current = async () => makeRates({ fetchedAt, profileHash: await profileHash(config.devProfile) });

  it("reuses fresh cached rates without a lookup", async () => {
    const lookup = vi.fn();
    const cached = await current();
    expect(await resolveRates(env, config, cached, daysLater(10), lookup)).toBe(cached);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("looks up and stamps currency, date and profile hash when stale", async () => {
    const lookup = vi.fn(async () => found);
    const now = daysLater(RATES_TTL_DAYS + 1);
    const rates = await resolveRates(env, config, await current(), now, lookup);
    expect(lookup).toHaveBeenCalledOnce();
    expect(rates).toEqual({
      ...found,
      currency: "EUR",
      fetchedAt: now.toISOString(),
      profileHash: await profileHash(config.devProfile),
    });
  });

  it("looks up when the profile changed", async () => {
    const lookup = vi.fn(async () => found);
    await resolveRates(env, makeConfig({ DEV_PROFILE: "Other profile." }), await current(), daysLater(1), lookup);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("looks up when there is no cache at all", async () => {
    const lookup = vi.fn(async () => found);
    expect((await resolveRates(env, config, null, daysLater(1), lookup))?.annualGross).toBe(70_000);
  });

  it("falls back to stale rates when the lookup fails", async () => {
    const stale = await current();
    const lookup = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(await resolveRates(env, config, stale, daysLater(RATES_TTL_DAYS + 5), lookup)).toBe(stale);
  });

  it("does not reuse stale rates in another currency", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("provider down");
    });
    expect(await resolveRates(env, makeConfig({ CURRENCY: "USD" }), await current(), daysLater(1), lookup)).toBeNull();
  });

  it("returns null (no salary section) when nothing is cached and the lookup fails", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("provider down");
    });
    await expect(resolveRates(env, config, null, daysLater(1), lookup)).resolves.toBeNull();
  });
});
