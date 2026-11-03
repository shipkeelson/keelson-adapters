#!/usr/bin/env node
// The Keelson adapter for coding agents with lifecycle hooks: one entry point for every hook. The agent's hook
// config passes the hook's name and the vendor (`node keelson.mjs pre-edit codex`; Claude Code by default).
//
//   session-start   session.start  -> a briefing in the agent's context
//   prompt          task.declare   -> a duplicate or wait warning in the agent's context
//   pre-edit        edit.intent    -> warn (default) or, with "edits": "block" in .keelson, stop the edit
//   post-edit       edit.done      (and, where the agent allows it, what Keelson said since the last answer)
//   post-tool       Cursor only: what Keelson said since the last answer, after any tool
//   post-bash       git.commit / git.push
//   session-end     session.end
//
// What differs between agents lives in lib/vendors.mjs. core/ is the source; each adapter folder holds a
// copy (node sync.mjs). It never stops an agent because Keelson is slow, down or not set up: every failure
// is "carry on".

import { readFileSync } from "node:fs";
import { describe, findProject, git, gitRoot, headStamp, remoteRepos } from "./lib/repo.mjs";
import { envelope, forget, projectsList, recall, remember, send, settings, stash, unstash } from "./lib/client.mjs";
import { VENDORS, allowOut, commandOf, contextOut, cwdOf, denyOut, doneEdits, plannedEdits, sessionOf, vendorOf } from "./lib/vendors.mjs";

const EDIT_LIMIT_MS = Number(process.env.KEELSON_EDIT_TIMEOUT_MS) || 300;   // design: past 300 ms the agent proceeds
const TASK_LIMIT_MS = 800;
const START_LIMIT_MS = 2500;
const MIN_TASK_CHARS = 25;
const SEVERITY = { deny: 3, wait: 2, sync_main: 1 };

function readInput() {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    return {};
  }
}

function emit(output) {
  if (output) process.stdout.write(JSON.stringify(output));
}

// Which Keelson project and GitHub repository this folder is: the .keelson file's (with its `repo` when it names one),
// else a remote of this clone that is in one of the key's projects (a fork's upstream, a renamed repository, a branch
// made before .keelson was committed). Kept per session, so an edit check asks nothing.
async function locate(input, config) {
  const session = sessionOf(input);
  const file = findProject(cwdOf(input));                // read every time: cheap, and settings in it take effect at once
  if (file?.repo) return file;
  const kept = recall(config, session, "located");
  let found = kept && kept.cwd === cwdOf(input) && kept.file === (file?.project ?? null) ? kept : null;
  if (!found) {
    const root = file?.root || gitRoot(cwdOf(input));
    const remotes = root ? remoteRepos(root) : [];
    const projects = root && config.apiKey ? await projectsList(config) : null;
    const lower = (s) => s.toLowerCase();
    const match = (projects || []).flatMap((p) => remotes.filter((r) => p.repos.some((x) => lower(x) === lower(r))).map((r) => ({ p, r })))
      .find(({ p }) => !file || p.id === file.project);
    found = { cwd: cwdOf(input), file: file?.project ?? null, root, id: match?.p.id ?? null, repo: match?.r ?? remotes[0] ?? null };
    remember(config, session, "located", found);
  }
  if (file) return { ...file, repo: found.repo };
  return found.id ? { root: found.root, project: found.id, repo: found.repo, edits: "warn", summary: false } : null;
}

// The project, repository, branch and base for this hook. Git is asked once per session and again only when HEAD
// moves, so an edit check costs no git process in the common case.
async function contextFor(input, config) {
  const session = sessionOf(input);
  const project = await locate(input, config);
  if (!project) return null;
  const stamp = headStamp(project.root);
  const cached = stamp && recall(config, session, "where");
  let where = cached && cached.stamp === stamp && cached.root === project.root ? cached : null;
  if (!where) {
    where = { ...describe(project.root, project.repo), developer: config.developer || git(project.root, "config", "user.name") || null, stamp, root: project.root };
    if (stamp && where.repo && where.branch) remember(config, session, "where", where);
  }
  if (!where.repo || !where.branch) return null;
  return { ...project, repo: where.repo, branch: where.branch, base: where.base, main: where.main, session, vendor: config.vendor,
           developer: where.developer ? where.developer.slice(0, 80) : null };
}

function describeEdit(edit) {
  const named = edit.functions.filter((f) => f !== "<module>");
  return named.length ? `${edit.path} (${named.slice(0, 3).join(", ")})` : edit.path;
}

// What Keelson said since the last answer ("main just changed code you are editing"). A hook that cannot show it
// keeps it for the next hook that can.
function heard(config, session, answer, extra = []) {
  const fresh = [...(Array.isArray(answer?.detail?.messages) ? answer.detail.messages.map((m) => m.text) : []), ...extra].filter(Boolean);
  if (fresh.length) remember(config, session, "messages", [...(recall(config, session, "messages") || []), ...fresh].slice(-20));
}

function messages(config, session) {
  const kept = recall(config, session, "messages") || [];
  if (kept.length) remember(config, session, "messages", []);
  return kept.map((text) => (text.startsWith("Keelson") ? text : `Keelson: ${text}`));
}

// Fence numbers: Keelson numbers each claim; sending the number back proves this session still holds the code.
function keys(edit) {
  return (edit.functions.length ? edit.functions : ["<file>"]).map((fn) => `${edit.path}::${fn}`);
}

function fenceFor(config, session, edit) {
  const known = recall(config, session, "fences") || {};
  const found = keys(edit).map((k) => known[k]).filter((f) => Number.isInteger(f));
  return found.length ? Math.max(...found) : undefined;
}

function keepFence(config, session, edit, fence) {
  if (!Number.isInteger(fence)) return;
  const known = recall(config, session, "fences") || {};
  for (const k of keys(edit)) known[k] = fence;
  remember(config, session, "fences", known);
}

function editData(config, session, edit, extra = {}) {
  const fence = fenceFor(config, session, edit);
  return { path: edit.path, functions: edit.functions, ...extra, ...(fence !== undefined ? { fence } : {}) };
}

async function sessionStart(input, config) {
  forget(config, sessionOf(input));                 // a new or resumed session looks its project up again
  const project = config.apiKey ? await locate(input, config) : findProject(cwdOf(input));
  if (!project) return;
  if (!config.apiKey) {
    const how = config.vendor === "claude_code" ? "set the Keelson plugin's API key (run /plugin, choose keelson, then configure)"
      : "run `npx keelson-watch login --key <your Keelson API key>` once on this machine";
    emit(contextOut(config.vendor, "start", `This repository is coordinated by Keelson (project ${project.project}), but Keelson is not connected for this user: ` +
      `${how}. Until then, other agents cannot see this session.`));
    return;
  }
  const ctx = await contextFor(input, config);
  if (!ctx) return;
  const [answer] = (await send(config, [envelope("session.start", ctx, { source: input.source || "startup" },
    { capabilities: { can_block: project.edits === "block", can_sync: false, can_receive: false } })], { timeoutMs: START_LIMIT_MS, queueOnFailure: true })) || [];
  const lines = [
    `Keelson coordinates this repository with every other agent working on it (project ${ctx.project}, ${ctx.repo}, branch ${ctx.branch}).`,
    "Keelson will tell you, in this conversation, when another agent already has the code you are about to edit, when that code changed on main, " +
      "or when someone is already doing your task. When it does, follow its advice and tell the user why.",
  ];
  if (answer?.reason) lines.push(answer.reason);
  else if (answer?.error) lines.push(`Keelson refused this session (${answer.error}): ${String(answer.detail).slice(0, 300)}`);
  emit(contextOut(config.vendor, "start", lines.join("\n")));
}

async function prompt(input, config) {
  const text = String(input.prompt || "").trim();
  if (text.length < MIN_TASK_CHARS || text.startsWith("/")) return;
  const ctx = await contextFor(input, config);
  if (!ctx || !config.apiKey) return;
  const data = { text: ctx.summary ? text.split("\n")[0].slice(0, 200) : text.slice(0, 8000) };
  const [answer] = (await send(config, [envelope("task.declare", ctx, data)], { timeoutMs: TASK_LIMIT_MS })) || [];
  heard(config, ctx.session, answer);
  const say = {
    stop: "Keelson: another agent or person is already doing this task. Before writing any code, tell the user and ask whether to continue.",
    wait: "Keelson: the code this task touches is held by another agent. Tell the user, and work on something else or wait.",
    build_on: "Keelson: another branch already does most of this. Tell the user, and build on that branch instead of starting over.",
    warn: "Keelson: you can go ahead, but watch for this.",
  }[answer?.decision];
  if (say) heard(config, ctx.session, null, [`${say}\n${answer.reason}`]);
  if (!VENDORS[config.vendor].promptContext) return;      // Cursor: shown with the next answer that can carry it
  const told = messages(config, ctx.session);
  if (told.length) emit(contextOut(config.vendor, "prompt", told.join("\n")));
}

async function preEdit(input, config) {
  const ctx = await contextFor(input, config);
  if (!ctx || !config.apiKey) return emit(allowOut(config.vendor));
  const edits = plannedEdits(config.vendor, input, ctx.root).filter((e) => !e.unchanged && !e.unknown);
  if (!edits.length) return emit(allowOut(config.vendor));
  stash(config, ctx.session, input.tool_use_id || "last", edits);
  const answers = (await send(config, edits.map((edit) => envelope("edit.intent", ctx, editData(config, ctx.session, edit, { tool: input.tool_name }))),
    { timeoutMs: EDIT_LIMIT_MS })) || [];
  let worst = null;
  edits.forEach((edit, i) => {
    const answer = answers[i];
    heard(config, ctx.session, answer);
    keepFence(config, ctx.session, edit, answer?.detail?.fence);
    if (answer && SEVERITY[answer.decision] && (!worst || SEVERITY[answer.decision] > SEVERITY[worst.answer.decision])) worst = { edit, answer };
  });
  const advice = worst && {
    wait: `Keelson: ${worst.answer.reason} Do not edit ${describeEdit(worst.edit)} now: work on other code or tell the user.`,
    deny: `Keelson: ${worst.answer.reason} Do not edit ${describeEdit(worst.edit)}.`,
    sync_main: `Keelson: ${worst.answer.reason} Commit your work, merge main into this branch (git fetch, then git merge ${ctx.main}), resolve any conflict, then make this edit.`,
  }[worst.answer.decision];
  if (advice && ctx.edits === "block") return emit(denyOut(config.vendor, [...messages(config, ctx.session), advice].join("\n")));
  if (!VENDORS[config.vendor].preContext) {               // Gemini CLI and Cursor: the advice rides on the next answer that can carry it
    if (advice) heard(config, ctx.session, null, [`${advice} (about the edit you just made)`]);
    return emit(allowOut(config.vendor));
  }
  const told = [...messages(config, ctx.session), ...(advice ? [advice] : [])];
  if (told.length) emit(contextOut(config.vendor, "pre", told.join("\n")));
}

async function postEdit(input, config) {
  const ctx = await contextFor(input, config);
  if (!ctx || !config.apiKey) return;
  const done = doneEdits(config.vendor, input, ctx.root);
  const edits = (done || unstash(config, ctx.session, input.tool_use_id || "last") || plannedEdits(config.vendor, input, ctx.root))
    .filter((e) => !e.unchanged && !e.unknown);
  if (done) {
    // Cursor names its edits only afterwards: claim them now, so the next agent is told.
    const claimed = (await send(config, edits.map((edit) => envelope("edit.intent", ctx, editData(config, ctx.session, edit))), { timeoutMs: 3000 })) || [];
    edits.forEach((edit, i) => {
      heard(config, ctx.session, claimed[i]);
      keepFence(config, ctx.session, edit, claimed[i]?.detail?.fence);
      if (claimed[i]?.decision === "wait") heard(config, ctx.session, null, [`${claimed[i].reason} (about the edit you just made to ${describeEdit(edit)})`]);
    });
  }
  const answers = (await send(config, edits.map((edit) => envelope("edit.done", ctx, editData(config, ctx.session, edit))),
    { timeoutMs: 3000, queueOnFailure: true })) || [];
  edits.forEach((edit, i) => heard(config, ctx.session, answers[i],
    answers[i]?.decision === "deny" ? [`${answers[i].reason} (about your last edit of ${describeEdit(edit)})`] : []));
  if (VENDORS[config.vendor].postContext && !done) {
    const told = messages(config, ctx.session);
    if (told.length) emit(contextOut(config.vendor, "post", told.join("\n")));
  }
}

async function postTool(input, config) {
  const ctx = await contextFor(input, config);
  if (!ctx) return;
  const told = messages(config, ctx.session);
  if (told.length) emit(contextOut(config.vendor, "post", told.join("\n")));
}

async function postBash(input, config) {
  const command = commandOf(input);
  const kind = /\bgit\s+push\b/.test(command) ? "git.push" : /\bgit\s+commit\b/.test(command) ? "git.commit" : null;
  if (!kind) return;
  const ctx = await contextFor(input, config);
  if (!ctx || !config.apiKey) return;
  const head = git(ctx.root, "rev-parse", "HEAD");
  const [answer] = (await send(config, [envelope(kind, ctx, { head })], { timeoutMs: 3000, queueOnFailure: true })) || [];
  heard(config, ctx.session, answer);
  if (kind === "git.push" && answer?.detail?.next_step && answer.detail.next_step !== "continue") {
    heard(config, ctx.session, null, [`After your push: ${answer.reason}`]);
  }
  if (VENDORS[config.vendor].postContext && config.vendor !== "cursor") {
    const told = messages(config, ctx.session);
    if (told.length) emit(contextOut(config.vendor, "post", told.join("\n")));
  }
}

async function sessionEnd(input, config) {
  const ctx = await contextFor(input, config);
  if (ctx && config.apiKey) await send(config, [envelope("session.end", ctx, { reason: input.reason || "other" })], { timeoutMs: 2500, queueOnFailure: true });
  forget(config, sessionOf(input));
}

const HANDLERS = { "session-start": sessionStart, prompt, "pre-edit": preEdit, "post-edit": postEdit, "post-tool": postTool, "post-bash": postBash,
                   "session-end": sessionEnd };

export async function main(hook, input = readInput(), config = settings(process.env, vendorOf(process.argv[3] || process.env.KEELSON_VENDOR))) {
  const handler = HANDLERS[hook];
  if (!handler) return;
  config = { ...config, vendor: vendorOf(config.vendor) };
  try {
    await handler(input, config);
  } catch {
    // never the reason an agent stops
    if (hook === "pre-edit") emit(allowOut(config.vendor));
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("keelson.mjs")) {
  await main(process.argv[2]);
}
