import { describe, expect, it } from "vitest";
import { computeWeekCost, STANDARD_WEEK_HOURS, WEEKS_PER_YEAR } from "../src/cost";
import { makeRates } from "./fixtures";

describe("computeWeekCost", () => {
  it("prices hours as a share of a standard week and at the freelance rate", () => {
    const cost = computeWeekCost(20, makeRates({ annualGross: 52_000, freelanceHourly: 80 }));
    expect(cost.employeeWeek).toBeCloseTo(500); // 52 000 / 52 × 20 / 40
    expect(cost.freelanceWeek).toBe(1600); // 20 × 80
    expect(cost.hours).toBe(20);
  });

  it("gives a full year's salary for 52 standard weeks", () => {
    const rates = makeRates();
    expect(computeWeekCost(STANDARD_WEEK_HOURS, rates).employeeWeek * WEEKS_PER_YEAR).toBeCloseTo(rates.annualGross);
  });

  it("is stable: same hours and rates → same amounts", () => {
    expect(computeWeekCost(12.4, makeRates())).toEqual(computeWeekCost(12.4, makeRates()));
  });

  it("is zero for zero hours", () => {
    expect(computeWeekCost(0, makeRates())).toMatchObject({ employeeWeek: 0, freelanceWeek: 0 });
  });
});
