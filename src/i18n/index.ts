import { en } from "./en";
import { ru } from "./ru";
import type { Lang, Messages } from "./types";

export type { Lang, Messages, PromptContext } from "./types";

const BUNDLES: Record<Lang, Messages> = { en, ru };

export function isLang(value: string): value is Lang {
  return value in BUNDLES;
}

export function getMessages(lang: Lang): Messages {
  return BUNDLES[lang];
}
