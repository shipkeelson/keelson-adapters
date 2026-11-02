import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Watcher, install, login } from "../keelson-watch.mjs";

const PROJECT = "kp_shop0000project";
const CART = "export function applyDiscount(total) {\n  return total\n}\n\nexport function count() {\n  return 1\n}\n";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "keelson-watch-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "ana/promo");
  run("config", "user.email", "ana@example.com");
  run("config", "user.name", "ana");
  run("remote", "add", "origin", "https://github.com/acme/api.git");
  writeFileSync(join(dir, "cart.js"), CART);
  writeFileSync(join(dir, ".gitignore"), "secret.txt\n");
  writeFileSync(join(dir, ".keelson"), JSON.stringify({ project: PROJECT, version: 1 }));
  run("add", ".");
  run("commit", "-q", "-m", "start");
  return { dir, run };
}

// A stand-in Keelson API on a local port: records events, answers with `decide`.
async function keelson(decide) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const events = JSON.parse(body || "{}").events || [];
      seen.push(...events);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ answers: events.map((e) => ({ seq: e.seq, type: e.type, decision: "ok", reason: "", detail: {}, ...decide(e) })) }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections(); server.close(); } };
}

test("the watcher reports the functions a file change touches, and prints Keelson's answer", async () => {
  const { dir } = repo();
  const api = await keelson((e) => (e.type === "edit.intent" && e.data.functions.includes("applyDiscount")
    ? { decision: "wait", reason: "Claude Code (sam) is editing applyDiscount." } : {}));
  const said = [];
  const watcher = new Watcher(dir, { agent: "Aider", config: { apiKey: "k", url: api.url, dataDir: dir, developer: "" }, out: (kind, text) => said.push([kind, text]) });
  await watcher.start();
  writeFileSync(join(dir, "cart.js"), CART.replace("return total", "return total * 2"));
  await watcher.changed("cart.js");
  writeFileSync(join(dir, "secret.txt"), "ignored");
  await watcher.changed("secret.txt");
  api.close();
  const intents = api.seen.filter((e) => e.type === "edit.intent");
  assert.deepEqual(intents.map((e) => [e.data.path, e.data.functions]), [["cart.js", ["applyDiscount"]]]);       // the ignored file is never sent
  assert.deepEqual([intents[0].session.vendor, intents[0].session.product, intents[0].session.developer], ["other", "Aider", "ana"]);
  assert.ok(said.some(([kind, text]) => kind === "wait" && text.includes("cart.js (applyDiscount)") && text.includes("Claude Code (sam)")));
});

test("commits are reported from the repository's own files", async () => {
  const { dir, run } = repo();
  const api = await keelson(() => ({}));
  const watcher = new Watcher(dir, { config: { apiKey: "k", url: api.url, dataDir: dir }, out: () => {} });
  writeFileSync(join(dir, "cart.js"), CART + "\n// more\n");
  run("commit", "-qam", "more");
  await watcher.checkGit();
  api.close();
  assert.deepEqual(api.seen.map((e) => e.type), ["git.commit"]);
});

test("login saves the key; install adds Keelson's hooks to Cursor, Gemini CLI and Codex without dropping the user's own", () => {
  const home = mkdtempSync(join(tmpdir(), "keelson-home-"));
  Object.assign(process.env, { KEELSON_HOME: join(home, ".keelson"), HOME: home, USERPROFILE: home });
  login(["--key", "kel_live_test", "--developer", "ana"]);
  assert.equal(JSON.parse(readFileSync(join(home, ".keelson", "config.json"), "utf8")).api_key, "kel_live_test");
  writeFileSync(join(home, "existing-cursor.json"), "");
  install(["cursor"]);
  install(["cursor"]);                                               // twice: replaced, not doubled
  const cursor = JSON.parse(readFileSync(join(home, ".cursor", "hooks.json"), "utf8"));
  assert.equal(cursor.version, 1);
  assert.equal(cursor.hooks.preToolUse.length, 1);
  assert.match(cursor.hooks.preToolUse[0].command, /keelson\.mjs" pre-edit cursor$/);
  install(["gemini"]);
  const gemini = JSON.parse(readFileSync(join(home, ".gemini", "settings.json"), "utf8"));
  assert.deepEqual(gemini.hooks.AfterTool.map((g) => g.matcher), ["write_file|replace", "run_shell_command"]);
  install(["codex"]);
  const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  assert.match(codex.hooks.PreToolUse[0].hooks[0].command, /\.keelson\/adapters\/codex\/keelson\.mjs" pre-edit codex$/);
});
