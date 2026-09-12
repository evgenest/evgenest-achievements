/**
 * Prompts of the market-rate lookup (see rates-lookup.ts). Internal, not report copy —
 * the only user-facing bit, `region`, is requested in the report language.
 */

export const EXTRACT_INSTRUCTIONS = `You prepare an anonymous market profile for a salary lookup. From the developer profile, extract ONLY:
- role: a generic job title as it would appear in job ads (e.g. "Backend developer");
- seniority: junior / mid / senior / lead / principal, or the closest equivalent;
- stack: up to 8 main technologies, most important first;
- region: the country (plus the city, only if the profile names one) where the developer works or looks for work;
- countryCode: the ISO 3166-1 alpha-2 code of that country, uppercase, or "" if unknown.
Never include names of people, employers, clients or projects, contact details, income, age or any other personal detail. If an attribute is not stated, use a generic value ("Software developer", "mid", an empty stack, "").`;

interface RatesPromptContext {
  currency: string;
  languageName: string;
  today: string; // YYYY-MM-DD
}

const ANSWER_RULES = ({ currency, languageName }: RatesPromptContext) => `Answer with:
- annualGross: the typical gross annual salary of an employed developer with this profile in this region;
- freelanceHourly: the typical freelance/contract hourly rate for the same profile and region.
One representative (median) number each, in ${currency} — convert from other currencies at the current exchange rate.
- region: the region these numbers apply to, written in ${languageName}.`;

export function searchInstructions(ctx: RatesPromptContext): string {
  return `You look up current market pay for a software developer profile. Today is ${ctx.today}.
Use the web search tool. Prefer the most popular job sites and salary databases for the profile's region (its main local job boards and salary aggregators) and the most recent data.
Search queries may contain ONLY the role, seniority, stack and region from the profile — nothing else.
${ANSWER_RULES(ctx)}
- sources: 1-5 pages you actually used, as {"title", "url"}.`;
}

export function knowledgeInstructions(ctx: RatesPromptContext): string {
  return `You estimate current market pay for a software developer profile. Today is ${ctx.today}.
Web search is not available: answer from your own knowledge of the job market in the profile's region.
${ANSWER_RULES(ctx)}`;
}

export function marketPrompt(profile: object): string {
  return `Profile (JSON):\n${JSON.stringify(profile)}`;
}
