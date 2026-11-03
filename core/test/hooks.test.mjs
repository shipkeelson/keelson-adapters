import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../keelson.mjs";
import { repoName } from "../lib/repo.mjs";

const PROJECT = "kp_shop0000project";
const CART = "export function applyDiscount(total) {\n  return total\n}\n\nexport function count() {\n  return 1\n}\n";

function repo({ keelson = { project: PROJECT, version: 1 } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "keelson-cc-"));
  const run = (...args) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  run("init", "-q", "-b", "sam/discount");
  run("config", "user.email", "sam@example.com");
  run("config", "user.name", "sam");
  run("remote", "add", "origin", "https://github.com/acme/api.git");
  writeFileSync(join(dir, "cart.js"), CART);
  if (keelson) writeFileSync(join(dir, ".keelson"), JSON.stringify(keelson));
  run("add", ".");
  run("commit", "-q", "-m", "start");
  return dir;
}

// A stand-in for the Keelson API: records each request and answers with `decide(event)`.
function server(decide, projects = []) {
  const seen = [];
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/v1/protocol/projects")) return new Response(JSON.stringify(projects), { status: 200 });
    const body = JSON.parse(init.body);
    seen.push({ url, auth: init.headers.authorization, events: body.events });
    return new Response(JSON.stringify({ answers: body.events.map((e) => ({ seq: e.seq, type: e.type, ...decide(e) })) }), { status: 200 });
  };
  return { seen, fetchImpl };
}

async function hook(name, input, config, fetchImpl) {
  const write = process.stdout.write;
  const original = globalThis.fetch;
  let out = "";
  process.stdout.write = (chunk) => { out += chunk; return true; };
  globalThis.fetch = fetchImpl;
  try {
    await main(name, input, config);
  } finally {
    process.stdout.write = write;
    globalThis.fetch = original;
  }
  return out ? JSON.parse(out) : null;
}

function config(dir, extra = {}) {
  return { apiKey: "kel_live_test", url: "https://keelson.test", developer: "", dataDir: join(dir, ".data"), ...extra };
}

test("repository names come from GitHub remotes", () => {
  assert.equal(repoName("https://github.com/acme/api.git"), "acme/api");
  assert.equal(repoName("git@github.com:acme/api.git"), "acme/api");
  assert.equal(repoName("https://gitlab.com/acme/api.git"), null);
  assert.equal(repoName("ssh://git@github.com:22/acme/api.git"), "acme/api");
  assert.equal(repoName("https://token@github.com/Acme/API"), "Acme/API");
});

test("a session starts with a briefing and sends one protocol envelope", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = server(() => ({ decision: "ok", reason: "Keelson: No coordination issues on this branch. Other live work in acme/api: kim/promo." }));
  const out = await hook("session-start", { session_id: "s1", cwd: dir, source: "startup" }, config(dir), api.fetchImpl);
  const [event] = api.seen[0].events;
  assert.equal(api.seen[0].url, "https://keelson.test/v1/protocol/events");
  assert.equal(api.seen[0].auth, "Bearer kel_live_test");
  assert.deepEqual([event.v, event.type, event.project, event.repo, event.branch, event.session.vendor, event.session.developer],
    [1, "session.start", PROJECT, "acme/api", "sam/discount", "claude_code", "sam"]);
  assert.match(out.hookSpecificOutput.additionalContext, /kim\/promo/);
});

test("an edit another agent holds is a warning by default and a stop with edits: block", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = server((e) => e.type === "edit.intent" && e.data.functions.includes("applyDiscount")
    ? { decision: "wait", reason: "kim/promo reserved applyDiscount in cart.js." } : { decision: "allow", reason: "Clear." });
  const edit = (tool_input) => ({ session_id: "s1", cwd: dir, tool_name: "Edit", tool_use_id: "t1", tool_input: { file_path: join(dir, "cart.js"), ...tool_input } });

  const warned = await hook("pre-edit", edit({ old_string: "return total", new_string: "return total * 0.9" }), config(dir), api.fetchImpl);
  assert.deepEqual(api.seen.at(-1).events[0].data, { path: "cart.js", functions: ["applyDiscount"], tool: "Edit" });
  assert.equal(warned.hookSpecificOutput.permissionDecision, undefined);
  assert.match(warned.hookSpecificOutput.additionalContext, /Do not edit cart\.js \(applyDiscount\) now/);

  const clear = await hook("pre-edit", edit({ old_string: "return 1", new_string: "return 2" }), config(dir), api.fetchImpl);
  assert.equal(clear, null);
  assert.deepEqual(api.seen.at(-1).events[0].data.functions, ["count"]);

  writeFileSync(join(dir, ".keelson"), JSON.stringify({ project: PROJECT, version: 1, edits: "block" }));
  const blocked = await hook("pre-edit", edit({ old_string: "return total", new_string: "x" }), config(dir), api.fetchImpl);
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
});

test("code that moved on main is synced first; the edit is reported when done", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = server((e) => e.type === "edit.intent" ? { decision: "sync_main", reason: "1 commit on main changed applyDiscount." } : { decision: "ok", reason: "" });
  const input = { session_id: "s1", cwd: dir, tool_name: "Edit", tool_use_id: "t9", tool_input: { file_path: join(dir, "cart.js"), old_string: "return total", new_string: "y" } };
  const out = await hook("pre-edit", input, config(dir), api.fetchImpl);
  assert.match(out.hookSpecificOutput.additionalContext, /merge main into this branch/);
  await hook("post-edit", input, config(dir), api.fetchImpl);
  assert.deepEqual([api.seen.at(-1).events[0].type, api.seen.at(-1).events[0].data.functions], ["edit.done", ["applyDiscount"]]);
});

test("a duplicate task is brought into Claude's context; short prompts and commands are not sent", async (t) => {
  const dir = repo();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = server(() => ({ decision: "stop", reason: "#808 (Claude Code) already looks like this work." }));
  assert.equal(await hook("prompt", { session_id: "s1", cwd: dir, prompt: "yes go ahead" }, config(dir), api.fetchImpl), null);
  assert.equal(await hook("prompt", { session_id: "s1", cwd: dir, prompt: "/keelson:status please tell me more" }, config(dir), api.fetchImpl), null);
  assert.equal(api.seen.length, 0);
  const out = await hook("prompt", { session_id: "s1", cwd: dir, prompt: "Add discount codes to the checkout page" }, config(dir), api.fetchImpl);
  assert.match(out.hookSpecificOutput.additionalContext, /already doing this task[\s\S]*#808/);
});

test("Keelson down, not set up, or not in this repository: Claude carries on and background events wait", async (t) => {
  const dir = repo();
  const plain = repo({ keelson: null });
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); });
  const down = async () => { throw new Error("ECONNREFUSED"); };
  const input = { session_id: "s1", cwd: dir, tool_name: "Edit", tool_use_id: "t1", tool_input: { file_path: join(dir, "cart.js"), old_string: "return total", new_string: "z" } };
  assert.equal(await hook("pre-edit", input, config(dir), down), null);
  await hook("post-edit", input, config(dir), down);
  const queue = join(dir, ".data", "queue.jsonl");
  assert.ok(existsSync(queue) && readFileSync(queue, "utf8").includes('"edit.done"'));

  const api = server(() => ({ decision: "ok", reason: "" }));
  await hook("session-end", { session_id: "s1", cwd: dir, reason: "other" }, config(dir), api.fetchImpl);
  assert.deepEqual(api.seen[0].events.map((e) => e.type), ["edit.done", "session.end"]);      // the kept event goes first

  const unconfigured = await hook("session-start", { session_id: "s2", cwd: dir }, config(dir, { apiKey: "" }), api.fetchImpl);
  assert.match(unconfigured.hookSpecificOutput.additionalContext, /not connected for this user/);
  assert.equal(await hook("pre-edit", { ...input, cwd: plain, tool_input: { ...input.tool_input, file_path: join(plain, "cart.js") } }, config(plain), api.fetchImpl), null);
  assert.equal(api.seen.length, 1);
});

test("a fork, or a branch made before .keelson was committed, joins the project through a matching remote", async (t) => {
  const dir = repo({ keelson: null });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["remote", "set-url", "origin", "https://github.com/lee/api.git"], { cwd: dir });   // lee's fork
  execFileSync("git", ["remote", "add", "upstream", "git@github.com:Acme/API.git"], { cwd: dir });       // the team's, other case
  const api = server(() => ({ decision: "allow", reason: "Clear." }), [{ id: PROJECT, name: "shop", repos: ["acme/api"] }]);
  const edit = { session_id: "f1", cwd: dir, tool_name: "Edit", tool_use_id: "t1", tool_input: { file_path: join(dir, "cart.js"), old_string: "return 1", new_string: "return 2" } };
  await hook("pre-edit", edit, config(dir), api.fetchImpl);
  const [sent] = api.seen.at(-1).events;
  assert.deepEqual([sent.project, sent.repo, sent.data.functions], [PROJECT, "Acme/API", ["count"]]);   // the server matches the case
  const outside = server(() => ({}), [{ id: PROJECT, name: "shop", repos: ["acme/web"] }]);
  assert.equal(await hook("pre-edit", { ...edit, session_id: "f2" }, config(join(dir, "other")), outside.fetchImpl), null);
  assert.equal(outside.seen.length, 0);                                                                // not in a project: nothing sent
});

test("a .keelson file that names its repository wins over the remotes", async (t) => {
  const dir = repo({ keelson: { project: PROJECT, repo: "acme/api", version: 1 } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["remote", "set-url", "origin", "https://github.com/lee/old-name.git"], { cwd: dir });
  const api = server(() => ({ decision: "allow", reason: "Clear." }));
  await hook("pre-edit", { session_id: "k1", cwd: dir, tool_name: "Edit", tool_use_id: "t1",
                           tool_input: { file_path: join(dir, "cart.js"), old_string: "return 1", new_string: "return 2" } }, config(dir), api.fetchImpl);
  assert.equal(api.seen.at(-1).events[0].repo, "acme/api");
});
