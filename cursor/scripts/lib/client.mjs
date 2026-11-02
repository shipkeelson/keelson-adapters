// Sending Keelson protocol events. Decisions an agent waits on have a tight time limit; past it the agent carries
// on (Keelson fails open, and the merge gate still checks). Events that could not be sent are kept and sent, in
// order, with the next request.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

export const DEFAULT_URL = "https://api.shipkeelson.com";
const QUEUE_LIMIT = 500;

// Where settings come from: Claude Code's plugin options, then KEELSON_* variables, then ~/.keelson/config.json
// (written by `keelson-watch login`, for agents whose plugins have no settings of their own: Codex, Cursor, Gemini CLI).
export function settings(env = process.env, vendor = env.KEELSON_VENDOR || "claude_code") {
  const home = env.KEELSON_HOME || join(homedir(), ".keelson");
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) || {};
  } catch {
    saved = {};
  }
  return {
    apiKey: env.CLAUDE_PLUGIN_OPTION_API_KEY || env.KEELSON_API_KEY || saved.api_key || "",
    url: (env.CLAUDE_PLUGIN_OPTION_URL || env.KEELSON_URL || saved.url || DEFAULT_URL).replace(/\/+$/, ""),
    developer: env.CLAUDE_PLUGIN_OPTION_DEVELOPER || env.KEELSON_DEVELOPER || saved.developer || "",
    dataDir: env.CLAUDE_PLUGIN_DATA || env.PLUGIN_DATA || home,
    vendor,
  };
}

const PRODUCTS = { claude_code: "Claude Code", codex: "Codex", cursor: "Cursor", gemini: "Gemini CLI", other: "Keelson Watch" };

function safe(id) {
  return String(id || "unknown").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

// Per-session scratch state (what PreToolUse worked out, for PostToolUse).
export function stash(config, session, key, value) {
  const dir = join(config.dataDir, "sessions", safe(session));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe(key)}.json`), JSON.stringify(value));
}

export function unstash(config, session, key) {
  const file = join(config.dataDir, "sessions", safe(session), `${safe(key)}.json`);
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    return value;
  } catch {
    return null;
  }
}

// Per-session values that stay until the session ends (unlike stash, which is read once).
export function remember(config, session, key, value) {
  stash(config, session, `keep-${key}`, value);
}

export function recall(config, session, key) {
  try {
    return JSON.parse(readFileSync(join(config.dataDir, "sessions", safe(session), `${safe(`keep-${key}`)}.json`), "utf8"));
  } catch {
    return null;
  }
}

export function forget(config, session) {
  rmSync(join(config.dataDir, "sessions", safe(session)), { recursive: true, force: true });
}

// Unique and increasing within a session without shared state, so hooks running at once never collide.
let last = 0;
export function nextSeq() {
  last = Math.max(last + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
  return last;
}

export function envelope(type, ctx, data = {}, extra = {}) {
  return {
    v: 1, type, project: ctx.project, repo: ctx.repo, branch: ctx.branch, base: ctx.base || null, seq: nextSeq(), at: new Date().toISOString(),
    session: { id: String(ctx.session).slice(0, 128), vendor: ctx.vendor || "claude_code", product: PRODUCTS[ctx.vendor || "claude_code"] || "Keelson adapter",
               developer: ctx.developer || null, machine: hostname().slice(0, 80) },
    data, ...extra,
  };
}

function queueFile(config) {
  return join(config.dataDir, "queue.jsonl");
}

function takeQueue(config) {
  const file = queueFile(config);
  if (!existsSync(file)) return [];
  const taken = `${file}.${process.pid}`;
  try {
    renameSync(file, taken);           // only one process takes each queued event
    const events = readFileSync(taken, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    rmSync(taken, { force: true });
    return events.slice(-QUEUE_LIMIT);
  } catch {
    return [];
  }
}

function keep(config, events) {
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(queueFile(config), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  } catch {
    // nowhere to keep it: the event is lost, and GitHub still shows the work
  }
}

// Sends `events` (queued ones first); returns the answers to `events`, or null if Keelson did not answer in time.
// `queueOnFailure`: background events are kept for later; decisions are not (they are stale by then).
export async function send(config, events, { timeoutMs = 300, queueOnFailure = false, fetchImpl = globalThis.fetch } = {}) {
  if (!config.apiKey) return null;
  const queued = takeQueue(config);
  const all = [...queued, ...events];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.url}/v1/protocol/events`, {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, "user-agent": `keelson-${config.vendor || "claude_code"}/0.2` },
      body: JSON.stringify({ events: all.slice(-100) }),
    });
    if (response.status >= 500 || response.status === 429) throw new Error(`keelson ${response.status}`);
    if (!response.ok) return { error: response.status, detail: await response.text().catch(() => "") };
    const body = await response.json();
    return (body.answers || []).slice(-events.length);
  } catch {
    keep(config, [...queued, ...(queueOnFailure ? events : [])]);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
