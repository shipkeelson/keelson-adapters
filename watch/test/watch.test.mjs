import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Watcher, install, login, notify, start, status, stop } from "../keelson-watch.mjs";

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

test("notifications use each platform's own tool and carry the text outside the command line", () => {
  const calls = [];
  const run = (cmd, args, opts) => { calls.push([cmd, args, opts.env.KEELSON_NOTE]); return { unref() {} }; };
  for (const platform of ["darwin", "linux", "win32"]) assert.equal(notify("`cart.ts`: Claude Code (sam) is editing it", { platform, run }), true);
  assert.deepEqual(calls.map((c) => c[0]), ["osascript", "notify-send", "powershell"]);
  assert.ok(calls.every((c) => c[2] === "cart.ts: Claude Code (sam) is editing it") && !calls[0][1].join(" ").includes("sam"));
  assert.equal(notify("x", { platform: "aix", run }), false);
});

test("status prints who is working in the project and on what", async () => {
  const { dir } = repo();
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/protocol/projects") return res.end(JSON.stringify([{ id: PROJECT, name: "shop", repos: ["acme/api"] }]));
    assert.equal(req.url, `/v1/protocol/projects/${PROJECT}/live`);
    res.end(JSON.stringify({ repos: { "acme/api": { agents: 1, claims: 1, waiting: 0, shown: [
      { agent: "Claude Code", owner: "sam", branch: "sam/discount", editing: ["`applyDiscount` in `cart.js`"], waiting_for: null }] } } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const lines = [];
  await status([dir], { config: { apiKey: "k", url: `http://127.0.0.1:${server.address().port}` }, print: (l) => lines.push(l) });
  server.closeAllConnections();
  server.close();
  assert.deepEqual(lines, ["acme/api: 1 agent, 1 function held, 0 waiting", "  Claude Code (sam) on sam/discount: editing applyDiscount in cart.js"]);
});

test("start runs the watcher in the background and stop ends it", async () => {
  const { dir } = repo();
  const api = await keelson(() => ({}));
  const home = mkdtempSync(join(tmpdir(), "keelson-home-"));
  Object.assign(process.env, { KEELSON_HOME: home, KEELSON_API_KEY: "k", KEELSON_URL: api.url, KEELSON_NOTIFY: "0" });
  start([dir]);
  const pidFile = (await import("node:fs")).readdirSync(join(home, "watch")).find((f) => f.endsWith(".pid"));
  const pid = Number(readFileSync(join(home, "watch", pidFile), "utf8"));
  for (let i = 0; i < 50 && !api.seen.some((e) => e.type === "session.start"); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(api.seen.some((e) => e.type === "session.start" && e.session.vendor === "other"));
  stop([dir]);
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0));
  api.close();
  delete process.env.KEELSON_API_KEY;
  delete process.env.KEELSON_URL;
});
