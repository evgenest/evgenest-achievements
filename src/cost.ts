import type { MarketRates, WeekCost } from "./types";

/** A full-time week: the employee's weekly share of the salary pays for this many hours. */
export const STANDARD_WEEK_HOURS = 40;
export const WEEKS_PER_YEAR = 52;

/**
 * What the week's focused hours are worth at the cached market rates — plain arithmetic,
 * no model involved, so two weeks with the same hours cost the same.
 */
export function computeWeekCost(hours: number, rates: MarketRates): WeekCost {
  return {
    hours,
    employeeWeek: (rates.annualGross / WEEKS_PER_YEAR) * (hours / STANDARD_WEEK_HOURS),
    freelanceWeek: hours * rates.freelanceHourly,
    rates,
  };
}
