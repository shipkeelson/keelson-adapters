// npm pack/publish: the package carries the Codex, Cursor and Gemini CLI adapters, so `keelson-watch install` works
// from npm as it does from the repository (where they sit next to this folder).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
rmSync(join(here, "adapters"), { recursive: true, force: true });
for (const vendor of ["codex", "cursor", "gemini"]) {
  for (const part of ["scripts", "hooks"]) {
    const from = join(here, "..", vendor, part);
    if (existsSync(from)) cpSync(from, join(here, "adapters", vendor, part), { recursive: true });
  }
}
