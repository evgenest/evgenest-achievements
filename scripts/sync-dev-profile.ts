#!/usr/bin/env bun
// Reads DEV_PROFILE.md and writes it as the DEV_PROFILE var into .dev.vars for local
// dev, so the markdown file stays the single source of truth. DEV_PROFILE is personal
// data (see README/SECURITY.md), so it is deployed as a Workers *secret*, not a var —
// this script never touches wrangler.prod.jsonc for it. `--print` instead prints the
// raw profile to stdout, for piping into `wrangler secret put`.

import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const mdPath = resolve(root, "DEV_PROFILE.md");
const devVarsPath = resolve(root, ".dev.vars");

function loadProfile(markdown: string): string {
  const lines = markdown.split("\n");
  // Drop a leading "# Title" line — it's a document heading, not prompt content.
  if (lines[0]?.startsWith("# ")) lines.shift();
  return lines.join("\n").trim();
}

// wrangler's bundled dotenv (16.3.1) only unescapes \n/\r inside double-quoted
// values — an embedded \" is left as a literal backslash instead of becoming ".
// Backtick-quoted values get no substitution at all, so raw multi-line content
// round-trips exactly as long as it contains no backtick itself.
function upsertDotenv(content: string, profile: string): string {
  if (profile.includes("`")) {
    throw new Error("DEV_PROFILE.md contains a backtick (`), which .dev.vars can't quote safely — remove it and rerun.");
  }
  const block = `DEV_PROFILE=\`${profile}\``;
  const existing = /^DEV_PROFILE=(?:"[^"]*"|`[^`]*`)/m;
  if (existing.test(content)) {
    return content.replace(existing, block);
  }
  return `${content.trimEnd()}\n\n${block}\n`;
}

const profile = loadProfile(await Bun.file(mdPath).text());

if (process.argv.includes("--print")) {
  process.stdout.write(profile);
} else {
  await Bun.write(devVarsPath, upsertDotenv(await Bun.file(devVarsPath).text(), profile));
  console.error("DEV_PROFILE synced into .dev.vars.");
  console.error("Next, to update the live secret:");
  console.error("  bun run scripts/sync-dev-profile.ts --print | wrangler secret put DEV_PROFILE --config wrangler.prod.jsonc");
}
