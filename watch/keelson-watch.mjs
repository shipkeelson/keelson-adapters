#!/usr/bin/env node
// keelson-watch: the Watcher tier (design: "Adapters"). Any agent with no Keelson adapter, or a person coding by
// hand, becomes visible to every other agent: it watches the repository folder and git, reports which functions
// change as they change, and prints Keelson's answers in the terminal. It cannot stop another program's edit.
//
//   keelson-watch [folder] [--agent Aider] [--sync] [--quiet]   watch a repository with a .keelson file (default: here)
//   keelson-watch start [folder] [...]   the same in the background (log in ~/.keelson/watch/); stop [folder] ends it
//   keelson-watch status [folder]        who is working in this project right now, and on what
//   keelson-watch login --key kel_live_... [--url https://api.shipkeelson.com] [--developer login]
//   keelson-watch install codex|cursor|gemini         add Keelson's hooks to that agent for this user
//
// --sync merges main into the branch when Keelson says code being edited moved on main, only when the working tree
// is clean (otherwise it says what to run). Answers that matter (wait, sync, messages) also show as a desktop
// notification unless --quiet. Settings: ~/.keelson/config.json (login), or KEELSON_API_KEY / KEELSON_URL.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { envelope, projectsList, send, settings } from "./lib/client.mjs";
import { writtenFunctions } from "./lib/outline.mjs";
import { describe, findProject, git, gitRoot, headStamp, remoteRepos } from "./lib/repo.mjs";

const HEARTBEAT_MS = 120_000;
const GIT_CHECK_MS = 3_000;
const SETTLE_MS = 300;
const SKIP = /(^|\/)(\.git|node_modules|dist|build|\.venv|venv|__pycache__|\.next|target|coverage)(\/|$)/;

// A desktop notification, best effort and never blocking: macOS (osascript), Linux (notify-send), Windows (a
// notification-area balloon through PowerShell). The text travels in an environment variable, never in a command line.
export function notify(text, { platform = process.platform, run = spawn } = {}) {
  if (process.env.KEELSON_NOTIFY === "0") return false;
  const body = String(text).replace(/`/g, "").slice(0, 240);
  const env = { ...process.env, KEELSON_NOTE: body };
  const commands = {
    darwin: ["osascript", ["-e", 'display notification (system attribute "KEELSON_NOTE") with title "Keelson"']],
    linux: ["notify-send", ["Keelson", body]],
    win32: ["powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; " +
      "$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; " +
      "$n.ShowBalloonTip(8000, 'Keelson', $env:KEELSON_NOTE, 'Info'); Start-Sleep -Seconds 9; $n.Dispose()"]],
  };
  const command = commands[platform];
  if (!command) return false;
  try {
    run(command[0], command[1], { env, detached: true, stdio: "ignore", windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}

function say(kind, text) {
  const colour = { wait: 33, deny: 31, sync_main: 36, info: 90, message: 35 }[kind] || 0;
  process.stderr.write(`\x1b[${colour}m[keelson] ${text}\x1b[0m\n`);
}

function sayAndNotify(kind, text) {
  say(kind, text);
  if (kind !== "info") notify(text);
}

function arg(argv, name) {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

// ---- login and install --------------------------------------------------------------------------------------

function home() {
  return process.env.KEELSON_HOME || join(homedir(), ".keelson");
}

export function login(argv) {
  const key = arg(argv, "--key") || process.env.KEELSON_API_KEY;
  if (!key) throw new Error("usage: keelson-watch login --key kel_live_... [--url URL] [--developer LOGIN]");
  mkdirSync(home(), { recursive: true });
  const file = join(home(), "config.json");
  const config = { api_key: key, url: arg(argv, "--url") || undefined, developer: arg(argv, "--developer") || undefined };
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: the file is in the user's profile, readable by that user
  }
  say("info", `Saved to ${file}. Agents with Keelson hooks on this machine now report to Keelson.`);
}

function merge(file, add) {
  let current = {};
  try {
    current = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    current = {};
  }
  const merged = add(current);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  return file;
}

function withoutKeelson(groups) {
  return (groups || []).filter((g) => !JSON.stringify(g).includes("keelson.mjs"));
}

export function install(argv) {
  const vendor = argv[0];
  const here = dirname(fileURLToPath(import.meta.url));
  const adapter = (part) => [join(here, "adapters", vendor, part), join(here, "..", vendor, part)].find((p) => existsSync(p));   // npm package, or the repository
  const source = adapter("scripts");
  if (!["codex", "cursor", "gemini"].includes(vendor) || !source) {
    throw new Error("usage: keelson-watch install codex|cursor|gemini (Claude Code: /plugin install keelson@shipkeelson)");
  }
  const target = join(home(), "adapters", vendor);
  cpSync(source, target, { recursive: true });
  const script = join(target, "keelson.mjs").split(sep).join("/");
  const run = (hook) => `node "${script}" ${hook} ${vendor}`;
  let file;
  if (vendor === "cursor") {
    file = merge(join(homedir(), ".cursor", "hooks.json"), (cfg) => {
      const hooks = cfg.hooks || {};
      const set = (event, hook, extra = {}) => { hooks[event] = [...withoutKeelson(hooks[event]), { command: run(hook), ...extra }]; };
      set("sessionStart", "session-start", { timeout: 10 });
      set("beforeSubmitPrompt", "prompt", { timeout: 5 });
      set("preToolUse", "pre-edit", { matcher: "Write", timeout: 5 });
      set("afterFileEdit", "post-edit", { timeout: 10 });
      set("postToolUse", "post-tool", { timeout: 5 });
      set("afterShellExecution", "post-bash", { timeout: 10 });
      set("sessionEnd", "session-end", { timeout: 5 });
      return { ...cfg, version: cfg.version || 1, hooks };
    });
  } else if (vendor === "gemini") {
    file = merge(join(homedir(), ".gemini", "settings.json"), (cfg) => {
      const hooks = cfg.hooks || {};
      const set = (event, hook, matcher, timeout) => {
        hooks[event] = [...withoutKeelson(hooks[event]), { ...(matcher ? { matcher } : {}), hooks: [{ name: `keelson-${hook}`, type: "command", command: run(hook), timeout }] }];
      };
      set("SessionStart", "session-start", "startup|resume|clear", 10000);
      set("BeforeAgent", "prompt", null, 5000);
      set("BeforeTool", "pre-edit", "write_file|replace", 5000);
      hooks.AfterTool = withoutKeelson(hooks.AfterTool);
      set("AfterTool", "post-edit", "write_file|replace", 10000);
      hooks.AfterTool.push({ matcher: "run_shell_command", hooks: [{ name: "keelson-post-bash", type: "command", command: run("post-bash"), timeout: 10000 }] });
      set("SessionEnd", "session-end", null, 5000);
      return { ...cfg, hooks };
    });
  } else {
    file = merge(join(homedir(), ".codex", "hooks.json"), (cfg) => {
      const plugin = JSON.parse(readFileSync(join(adapter("hooks"), "hooks.json"), "utf8")).hooks;
      const hooks = cfg.hooks || {};
      for (const [event, groups] of Object.entries(plugin)) {
        hooks[event] = [...withoutKeelson(hooks[event]), ...JSON.parse(JSON.stringify(groups).replaceAll("${PLUGIN_ROOT}/scripts/keelson.mjs", script))];
      }
      return { ...cfg, hooks };
    });
  }
  say("info", `Keelson hooks added to ${file}. Restart ${vendor} (Codex and Gemini CLI ask you to trust new hooks: run /hooks).`);
}

// ---- the watcher ---------------------------------------------------------------------------------------------

// The folder's Keelson project and GitHub repository: the .keelson file's, else a remote of the clone that is in one of
// the key's projects (a fork's upstream, a renamed repository, a branch made before .keelson was committed).
export async function locateFolder(folder, config) {
  const file = findProject(folder);
  if (file?.repo) return file;
  const root = file?.root || gitRoot(folder);
  if (!root) return null;
  const remotes = remoteRepos(root);
  const projects = config.apiKey ? await projectsList(config) : null;
  const lower = (s) => s.toLowerCase();
  const match = (projects || []).flatMap((p) => remotes.filter((r) => p.repos.some((x) => lower(x) === lower(r))).map((r) => ({ p, r })))
    .find(({ p }) => !file || p.id === file.project);
  if (file) return { ...file, repo: match?.r || remotes[0] || null };
  return match ? { root, project: match.p.id, repo: match.r, edits: "warn", summary: false } : null;
}

export class Watcher {
  constructor(folder, { agent = "Keelson Watch", sync = false, config = settings(process.env, "other"), out = say, project = findProject(folder) } = {}) {
    if (!project) throw new Error(`${folder} is not in a Keelson project: commit the project's .keelson file, or add this repository to a project on the dashboard`);
    this.project = project;
    this.sync = sync;
    this.out = out;
    this.config = { ...config, vendor: "other" };
    this.agent = agent;
    this.session = `watch-${hostname()}-${process.pid}`.slice(0, 120);
    this.before = new Map();
    this.timers = new Map();
    this.fences = new Map();
    this.where();
  }

  where() {
    const found = describe(this.project.root, this.project.repo);
    this.ctx = { ...this.project, repo: found.repo, branch: found.branch, base: found.base, main: found.main, session: this.session, vendor: "other",
                 developer: (this.config.developer || git(this.project.root, "config", "user.name") || "").slice(0, 80) || null };
    this.stamp = headStamp(this.project.root);
    this.head = git(this.project.root, "rev-parse", "HEAD");
    this.remote = this.ctx.branch ? git(this.project.root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${this.ctx.branch}`) : null;
  }

  event(type, data = {}, extra = {}) {
    const env = envelope(type, this.ctx, data, extra);
    env.session.product = this.agent.slice(0, 80);
    return env;
  }

  async start() {
    if (!this.config.apiKey) throw new Error("not logged in: run keelson-watch login --key kel_live_...");
    const [answer] = (await send(this.config, [this.event("session.start", { source: "watch" },
      { capabilities: { can_block: false, can_sync: this.sync, can_receive: true } })], { timeoutMs: 5000, queueOnFailure: true })) || [];
    this.out("info", `Watching ${this.ctx.repo} on ${this.ctx.branch} for project ${this.ctx.project}.`);
    if (answer?.reason) this.out("info", answer.reason);
  }

  ignored(path) {
    try {
      execFileSync("git", ["check-ignore", "-q", path], { cwd: this.project.root, stdio: "ignore", timeout: 2000, windowsHide: true });
      return true;                         // exit 0: git ignores it
    } catch {
      return false;
    }
  }

  // A file changed: which functions, compared with what it held before (first time: the last commit).
  async changed(path) {
    if (SKIP.test(path) || this.ignored(path)) return;
    let after = "";
    try {
      after = readFileSync(join(this.project.root, path), "utf8");
    } catch {
      after = "";
    }
    const before = this.before.has(path) ? this.before.get(path) : (git(this.project.root, "show", `HEAD:${path}`) ?? "");
    this.before.set(path, after);
    if (before === after) return;
    const functions = writtenFunctions(path, before, after);
    if (Array.isArray(functions) && functions.length === 0) return;
    const named = functions || [];
    const key = `${path}::${named.join(",")}`;
    const data = { path, functions: named, activity: `editing ${path}`, ...(this.fences.has(key) ? { fence: this.fences.get(key) } : {}) };
    const [intent] = (await send(this.config, [this.event("edit.intent", data), this.event("edit.done", { path, functions: named })],
      { timeoutMs: 3000, queueOnFailure: true })) || [];
    if (Number.isInteger(intent?.detail?.fence)) this.fences.set(key, intent.detail.fence);
    this.answer(intent, `${path}${named.length ? ` (${named.filter((f) => f !== "<module>").join(", ") || "top level"})` : ""}`);
  }

  answer(answer, what) {
    for (const message of answer?.detail?.messages || []) this.message(message);
    if (!answer || !["wait", "deny", "sync_main"].includes(answer.decision)) return;
    this.out(answer.decision, `${what}: ${answer.reason}`);
    if (answer.decision === "sync_main") this.syncMain();
  }

  message(message) {
    this.out("message", message.text);
    if (message.kind === "main_changed") this.syncMain();
  }

  syncMain() {
    if (!this.sync) return this.out("sync_main", `Merge main before going on: git fetch origin && git merge origin/${this.ctx.main || "main"}`);
    if (git(this.project.root, "status", "--porcelain")) {
      return this.out("sync_main", "Not merging main: the working tree has uncommitted changes. Commit them, then: " +
        `git fetch origin && git merge origin/${this.ctx.main || "main"}`);
    }
    try {
      execFileSync("git", ["fetch", "-q", "origin"], { cwd: this.project.root, stdio: "ignore", timeout: 60_000 });
      execFileSync("git", ["merge", "--no-edit", `origin/${this.ctx.main || "main"}`], { cwd: this.project.root, stdio: "ignore", timeout: 60_000 });
      this.out("info", "Merged main into this branch.");
    } catch {
      execFileSync("git", ["merge", "--abort"], { cwd: this.project.root, stdio: "ignore" });
      this.out("sync_main", "Merging main conflicts; merged nothing. Merge it yourself and resolve the conflict.");
    }
  }

  // Commits, pushes and branch switches, from the repository's own files (no process per check).
  async checkGit() {
    const stamp = headStamp(this.project.root);
    if (stamp === this.stamp) {
      const remote = this.ctx.branch ? git(this.project.root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${this.ctx.branch}`) : null;
      if (remote && remote !== this.remote) {
        this.remote = remote;
        if (remote === this.head) {
          const [answer] = (await send(this.config, [this.event("git.push", { head: this.head })], { timeoutMs: 3000, queueOnFailure: true })) || [];
          if (answer?.detail?.next_step && answer.detail.next_step !== "continue") this.out("wait", `After your push: ${answer.reason}`);
        }
      }
      return;
    }
    const oldBranch = this.ctx.branch;
    const oldHead = this.head;
    this.where();
    if (this.ctx.branch !== oldBranch) {
      await send(this.config, [{ ...this.event("session.end"), branch: oldBranch }], { timeoutMs: 3000, queueOnFailure: true });
      this.before.clear();
      await this.start();
    } else if (this.head !== oldHead) {
      await send(this.config, [this.event("git.commit", { head: this.head })], { timeoutMs: 3000, queueOnFailure: true });
      this.before.clear();
    }
  }

  async heartbeat() {
    const [answer] = (await send(this.config, [this.event("heartbeat", { activity: "working (seen by keelson-watch)" })], { timeoutMs: 3000 })) || [];
    for (const message of answer?.detail?.messages || []) this.message(message);
  }

  // Messages pushed mid-session, when the project has a coordinator; otherwise they come with each answer.
  async stream(signal) {
    const url = `${this.config.url}/v1/protocol/projects/${this.ctx.project}/stream?repo=${encodeURIComponent(this.ctx.repo)}&branch=${encodeURIComponent(this.ctx.branch)}`;
    for (let wait = 1000; !signal.aborted; wait = Math.min(wait * 2, 60_000)) {
      try {
        const response = await fetch(url, { headers: { authorization: `Bearer ${this.config.apiKey}`, accept: "text/event-stream" }, signal });
        if (response.status === 503 || response.status === 404) return;      // no coordinator: answers carry the messages
        if (!response.ok || !response.body) throw new Error(String(response.status));
        wait = 1000;
        let buffer = "";
        for await (const chunk of response.body) {
          buffer += Buffer.from(chunk).toString("utf8");
          let at;
          while ((at = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
            if (data) this.message(JSON.parse(data));
          }
        }
      } catch {
        if (signal.aborted) return;
      }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  async run() {
    await this.start();
    const stop = new AbortController();
    const watcher = watch(this.project.root, { recursive: true }, (_kind, name) => {
      if (!name) return;
      const path = String(name).split(sep).join("/");
      if (SKIP.test(path)) return;
      clearTimeout(this.timers.get(path));
      this.timers.set(path, setTimeout(() => { this.timers.delete(path); this.changed(path).catch(() => {}); }, SETTLE_MS));
    });
    const gitTimer = setInterval(() => this.checkGit().catch(() => {}), GIT_CHECK_MS);
    const beat = setInterval(() => this.heartbeat().catch(() => {}), HEARTBEAT_MS);
    this.stream(stop.signal).catch(() => {});
    const end = async () => {
      watcher.close();
      clearInterval(gitTimer);
      clearInterval(beat);
      stop.abort();
      await send(this.config, [this.event("session.end")], { timeoutMs: 2500, queueOnFailure: true });
      process.exit(0);
    };
    process.on("SIGINT", end);
    process.on("SIGTERM", end);
  }
}

// ---- status, and running in the background ------------------------------------------------------------------

export async function status(argv, { config = settings(process.env, "other"), print = (line) => process.stdout.write(`${line}\n`) } = {}) {
  const folder = argv[0] && !argv[0].startsWith("--") ? argv[0] : process.cwd();
  if (!config.apiKey) throw new Error("not logged in: run keelson-watch login --key kel_live_...");
  const project = await locateFolder(folder, config);
  if (!project) throw new Error(`${folder} is not in a Keelson project you can see`);
  const response = await fetch(`${config.url}/v1/protocol/projects/${project.project}/live`, { headers: { authorization: `Bearer ${config.apiKey}` } });
  if (response.status === 503) return print("The live view needs Keelson's project coordinators, which are not running for this project.");
  if (!response.ok) throw new Error(`Keelson answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const live = await response.json();
  for (const [repo, state] of Object.entries(live.repos || {})) {
    print(`${repo}: ${state.agents} agent${state.agents === 1 ? "" : "s"}, ${state.claims} function${state.claims === 1 ? "" : "s"} held, ${state.waiting} waiting`);
    for (const a of state.shown || []) {
      const editing = (a.editing || []).map((e) => e.replace(/`/g, "")).slice(0, 3).join(", ");
      print(`  ${a.agent}${a.owner ? ` (${a.owner})` : ""} on ${a.branch}${editing ? `: editing ${editing}` : ""}${a.waiting_for ? `, waiting for ${a.waiting_for}` : ""}`);
    }
  }
  if (!Object.keys(live.repos || {}).length) print("No agents working in this project right now.");
  return live;
}

function pidFile(folder) {
  const root = findProject(folder)?.root;
  if (!root) throw new Error(`no .keelson file in ${folder} or above`);
  const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
  const dir = join(home(), "watch");
  mkdirSync(dir, { recursive: true });
  return { pid: join(dir, `${id}.pid`), log: join(dir, `${id}.log`), root };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function start(argv) {
  const folder = argv[0] && !argv[0].startsWith("--") ? argv[0] : process.cwd();
  const files = pidFile(folder);
  const running = existsSync(files.pid) ? Number(readFileSync(files.pid, "utf8")) : 0;
  if (running && alive(running)) return say("info", `Already watching ${files.root} (process ${running}); log: ${files.log}`);
  const out = openSync(files.log, "a");
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), files.root, ...argv.filter((a) => a !== argv[0] || a.startsWith("--"))],
    { detached: true, stdio: ["ignore", out, out], windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
  child.unref();
  writeFileSync(files.pid, String(child.pid));
  say("info", `Watching ${files.root} in the background (process ${child.pid}). Log: ${files.log}. Stop: keelson-watch stop`);
}

export function stop(argv) {
  const folder = argv[0] && !argv[0].startsWith("--") ? argv[0] : process.cwd();
  const files = pidFile(folder);
  const running = existsSync(files.pid) ? Number(readFileSync(files.pid, "utf8")) : 0;
  if (!running || !alive(running)) {
    rmSync(files.pid, { force: true });
    return say("info", `Not watching ${files.root}.`);
  }
  process.kill(running, "SIGTERM");
  rmSync(files.pid, { force: true });
  say("info", `Stopped watching ${files.root}.`);
}

export async function cli(argv = process.argv.slice(2)) {
  if (argv[0] === "login") return login(argv.slice(1));
  if (argv[0] === "install") return install(argv.slice(1));
  if (argv[0] === "status") return status(argv.slice(1));
  if (argv[0] === "start") return start(argv.slice(1));
  if (argv[0] === "stop") return stop(argv.slice(1));
  const folder = argv[0] && !argv[0].startsWith("--") ? argv[0] : process.cwd();
  const out = argv.includes("--quiet") ? say : sayAndNotify;
  const config = settings(process.env, "other");
  await new Watcher(folder, { agent: arg(argv, "--agent") || "Keelson Watch", sync: argv.includes("--sync"), out, config,
                              project: await locateFolder(folder, config) }).run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  cli().catch((error) => {
    say("deny", error.message);
    process.exit(1);
  });
}

