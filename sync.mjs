#!/usr/bin/env node
// Copies the shared adapter code (adapters/core) into each adapter, which must stand alone when installed:
//
//   node adapters/sync.mjs           copy
//   node adapters/sync.mjs --check   fail if any copy differs from adapters/core (CI runs this)

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const core = join(here, "core");
const libs = readdirSync(join(core, "lib")).filter((f) => f.endsWith(".mjs"));
export const TARGETS = {
  "claude-code/scripts": ["keelson.mjs", ...libs.map((f) => `lib/${f}`)],
  "codex/scripts": ["keelson.mjs", ...libs.map((f) => `lib/${f}`)],
  "cursor/scripts": ["keelson.mjs", ...libs.map((f) => `lib/${f}`)],
  "gemini/scripts": ["keelson.mjs", ...libs.map((f) => `lib/${f}`)],
  "watch": libs.map((f) => `lib/${f}`),
};

export function differences() {
  const stale = [];
  for (const [target, files] of Object.entries(TARGETS)) {
    for (const file of files) {
      const copy = join(here, target, file);
      if (!existsSync(copy) || readFileSync(copy, "utf8") !== readFileSync(join(core, file), "utf8")) stale.push(join(target, file));
    }
  }
  return stale;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) {
    const stale = differences();
    if (stale.length) {
      console.error(`Adapter copies differ from adapters/core (run node adapters/sync.mjs):\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
  } else {
    for (const [target, files] of Object.entries(TARGETS)) {
      for (const file of files) {
        mkdirSync(dirname(join(here, target, file)), { recursive: true });
        copyFileSync(join(core, file), join(here, target, file));
      }
    }
  }
}
