import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { Config } from "./config";

export interface ZdrOptions {
  /**
   * Require the endpoint to support strict structured output. True gives schema-guaranteed JSON,
   * but narrows the ZDR pool — for some models down to a single provider, whose outage then sinks
   * the run. False keeps ZDR and lets any ZDR endpoint answer, with the JSON held together by the
   * recovery path in llm.ts instead of the schema. Used as a fallback, never as the first attempt.
   */
  strictStructuredOutput?: boolean;
}

/**
 * OpenRouter, locked to zero data retention: the report payload carries private commit data
 * and the rates lookup sees DEV_PROFILE, so a request may only reach endpoints that keep
 * neither prompt nor completion (which also rules out training on them). Not configurable on
 * purpose — if no such endpoint serves the model, the request fails instead of falling back
 * to one that retains data.
 *
 * ZDR covers model inference only. Server tools (`tools.webSearch`) run outside it — see
 * rates-lookup.ts for what reaches the search engine.
 */
export function openRouterZdr(env: Env, config: Config, options: ZdrOptions = {}) {
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  const effort = config.llm.reasoningEffort;
  const model = openrouter.chat(config.llm.model, {
    provider: {
      zdr: true,
      data_collection: "deny",
      // Skip endpoints without strict structured output instead of letting them degrade the JSON.
      require_parameters: options.strictStructuredOutput ?? true,
    },
    // This provider ignores the SDK-level `reasoning` option and reads only its own setting.
    ...(effort === "provider-default" ? {} : { reasoning: { effort } }),
  });
  return { model, tools: openrouter.tools };
}
