// What differs between coding agents: how a hook's input names the session, the folder and the edit, and how an
// answer goes back into the agent. Everything else (the protocol, fences, messages, failing open) is shared.
//
//   claude_code  Claude Code hooks: Edit, MultiEdit, Write, NotebookEdit; hookSpecificOutput (additionalContext, deny)
//   codex        Codex hooks: apply_patch (tool_input.command holds the patch); the same output shape as Claude Code
//   gemini       Gemini CLI hooks: replace and write_file in BeforeTool/AfterTool; deny is {decision, reason}, and
//                BeforeTool cannot add context, so advice there rides on AfterTool
//   cursor       Cursor hooks: preToolUse (Write) can deny with agent_message; context only at sessionStart and
//                postToolUse; afterFileEdit names the edits after they happen

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inside } from "./repo.mjs";
import { editedFunctions, writtenFunctions } from "./outline.mjs";

export const VENDORS = {
  claude_code: { events: { start: "SessionStart", prompt: "UserPromptSubmit", pre: "PreToolUse", post: "PostToolUse" }, shape: "claude",
                 promptContext: true, preContext: true, postContext: false },
  codex: { events: { start: "SessionStart", prompt: "UserPromptSubmit", pre: "PreToolUse", post: "PostToolUse" }, shape: "claude",
           promptContext: true, preContext: true, postContext: true },
  gemini: { events: { start: "SessionStart", prompt: "BeforeAgent", pre: "BeforeTool", post: "AfterTool" }, shape: "gemini",
            promptContext: true, preContext: false, postContext: true },
  cursor: { events: {}, shape: "cursor", promptContext: false, preContext: false, postContext: true },
};

export function vendorOf(name) {
  return VENDORS[name] ? name : "claude_code";
}

export function sessionOf(input) {
  return input.session_id || input.conversation_id || process.env.GEMINI_SESSION_ID || "unknown";
}

export function cwdOf(input) {
  return input.cwd || (Array.isArray(input.workspace_roots) && input.workspace_roots[0]) || process.env.GEMINI_PROJECT_DIR ||
    process.env.CURSOR_PROJECT_DIR || process.cwd();
}

export function commandOf(input) {
  return String(input.tool_input?.command ?? input.command ?? "");
}

// ---- answers back into the agent ------------------------------------------------------------------------------

export function contextOut(vendor, stage, text) {
  const spec = VENDORS[vendor];
  if (spec.shape === "cursor") return { additional_context: text };
  return { hookSpecificOutput: { hookEventName: spec.events[stage], additionalContext: text } };
}

export function denyOut(vendor, text) {
  const spec = VENDORS[vendor];
  if (spec.shape === "gemini") return { decision: "deny", reason: text };
  if (spec.shape === "cursor") return { permission: "deny", agent_message: text, user_message: text };
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: text } };
}

// Cursor treats a permission hook with no valid JSON answer as a refusal, so it always gets an explicit allow.
export function allowOut(vendor) {
  return VENDORS[vendor].shape === "cursor" ? { permission: "allow" } : null;
}

// ---- edits ----------------------------------------------------------------------------------------------------

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

// Codex's apply_patch format: "*** Begin Patch", then per file "*** Update File: p" (hunks after "@@" lines, with
// " " context, "-" removed and "+" added lines, optionally "*** Move to: q"), "*** Add File: p" ("+" lines) or
// "*** Delete File: p", then "*** End Patch".
export function parsePatch(text) {
  const files = [];
  let file = null;
  let hunk = null;
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const header = raw.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      file = { kind: header[1].toLowerCase(), path: header[2].trim(), hunks: [], added: [] };
      hunk = null;
      files.push(file);
      continue;
    }
    if (!file || raw.startsWith("*** End Patch") || raw.startsWith("*** Begin Patch")) continue;
    if (raw.startsWith("*** Move to: ")) {
      file.moveTo = raw.slice(13).trim();
      continue;
    }
    if (raw.startsWith("*** End of File")) continue;
    if (file.kind === "add") {
      if (raw.startsWith("+")) file.added.push(raw.slice(1));
      continue;
    }
    if (raw.startsWith("@@")) {
      hunk = { old: [], new: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      hunk = { old: [], new: [] };
      file.hunks.push(hunk);
    }
    if (raw.startsWith("-")) hunk.old.push(raw.slice(1));
    else if (raw.startsWith("+")) hunk.new.push(raw.slice(1));
    else if (raw.startsWith(" ") || raw === "") {
      hunk.old.push(raw.slice(1));
      hunk.new.push(raw.slice(1));
    }
  }
  return files;
}

function one(root, absolute, functions) {
  const path = inside(root, absolute);
  if (!path) return null;
  if (Array.isArray(functions) && functions.length === 0) return { path, functions: [], unchanged: true };
  return { path, functions: functions || [] };
}

// The files and functions a tool call is about to change (before it runs), in the repository at `root`.
// `unknown`: the agent did not say what it changes, so only the file is known.
export function plannedEdits(vendor, input, root) {
  const tool = input.tool_name;
  const args = input.tool_input || {};
  const base = cwdOf(input);
  const edits = [];
  if (vendor === "codex") {
    if (tool !== "apply_patch") return [];
    for (const file of parsePatch(args.command ?? args.patch ?? args.input)) {
      const absolute = resolve(base, file.path);
      const rel = inside(root, absolute);
      if (!rel) continue;
      const before = read(absolute);
      let functions = null;
      if (file.kind === "add") functions = writtenFunctions(rel, "", file.added.join("\n"));
      else if (file.kind === "delete") functions = writtenFunctions(rel, before, "");
      else functions = editedFunctions(rel, before, file.hunks.map((h) => ({ old_string: h.old.join("\n") })));
      const edit = one(root, absolute, functions);
      if (edit) edits.push(edit);
      if (file.moveTo) {
        const moved = one(root, resolve(base, file.moveTo), null);
        if (moved) edits.push(moved);
      }
    }
    return edits;
  }
  if (vendor === "gemini") {
    const absolute = args.file_path ? resolve(base, args.file_path) : null;
    if (!absolute) return [];
    const rel = inside(root, absolute);
    if (!rel) return [];
    if (tool === "replace") return [one(root, absolute, editedFunctions(rel, read(absolute), [{ old_string: args.old_string }]))].filter(Boolean);
    if (tool === "write_file") return [one(root, absolute, writtenFunctions(rel, read(absolute) ?? "", args.content))].filter(Boolean);
    return [];
  }
  if (vendor === "cursor") {
    const target = args.file_path || args.path || args.target_file || input.file_path;
    if (!target) return [];
    const absolute = resolve(base, target);
    const rel = inside(root, absolute);
    if (!rel) return [];
    const before = read(absolute);
    let functions = null;
    if (typeof args.old_string === "string") functions = editedFunctions(rel, before, [{ old_string: args.old_string }]);
    else if (typeof args.content === "string" || typeof args.contents === "string") functions = writtenFunctions(rel, before ?? "", args.content ?? args.contents);
    else return [{ path: rel, functions: [], unknown: true }];
    return [one(root, absolute, functions)].filter(Boolean);
  }
  const absolute = args.file_path || args.notebook_path;
  const rel = inside(root, absolute);
  if (!rel) return [];
  const before = read(absolute);
  let functions = null;
  if (tool === "Edit") functions = editedFunctions(rel, before, [args]);
  else if (tool === "MultiEdit") functions = editedFunctions(rel, before, args.edits || []);
  else if (tool === "Write") functions = writtenFunctions(rel, before, args.content);
  return [one(root, absolute, functions)].filter(Boolean);
}

// Cursor's afterFileEdit: the edits already happened, so the new text is found in the file as it is now.
export function doneEdits(vendor, input, root) {
  if (vendor !== "cursor" || !input.file_path) return null;
  const absolute = resolve(cwdOf(input), input.file_path);
  const rel = inside(root, absolute);
  if (!rel) return [];
  const edits = Array.isArray(input.edits) ? input.edits : [];
  const functions = edits.length ? editedFunctions(rel, read(absolute), edits.map((e) => ({ old_string: e.new_string }))) : null;
  return [one(root, absolute, functions)].filter(Boolean);
}
