import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { allowOut, contextOut, denyOut, doneEdits, parsePatch, plannedEdits } from "../lib/vendors.mjs";

const CART = "export function applyDiscount(total) {\n  return total\n}\n\nexport function count() {\n  return 1\n}\n";

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "keelson-vendors-"));
  writeFileSync(join(dir, "cart.js"), CART);
  return dir;
}

test("a Codex patch is read file by file: updates by hunk, added and deleted files whole", () => {
  const patch = ["*** Begin Patch", "*** Update File: cart.js", "@@ export function applyDiscount(total) {", "-  return total", "+  return total * 0.9",
    "*** Add File: promo.js", "+export function promo() {", "+  return 1", "+}", "*** Delete File: old.js", "*** End Patch"].join("\n");
  const [update, add, remove] = parsePatch(patch);
  assert.deepEqual([update.kind, update.path, update.hunks[0].old, update.hunks[0].new], ["update", "cart.js", ["  return total"], ["  return total * 0.9"]]);
  assert.deepEqual([add.kind, add.added], ["add", ["export function promo() {", "  return 1", "}"]]);
  assert.equal(remove.kind, "delete");
});

test("Codex apply_patch names the functions it changes; other tools are not edits", () => {
  const root = folder();
  const patch = "*** Begin Patch\n*** Update File: cart.js\n@@\n export function count() {\n-  return 1\n+  return 2\n }\n*** Add File: promo.js\n+export function promo() {\n+  return 1\n+}\n*** End Patch\n";
  const edits = plannedEdits("codex", { tool_name: "apply_patch", cwd: root, tool_input: { command: patch } }, root);
  assert.deepEqual(edits, [{ path: "cart.js", functions: ["count"] }, { path: "promo.js", functions: ["promo"] }]);
  assert.deepEqual(plannedEdits("codex", { tool_name: "Bash", cwd: root, tool_input: { command: "ls" } }, root), []);
});

test("Gemini CLI replace and write_file, and Cursor's edits named after the fact", () => {
  const root = folder();
  const replace = plannedEdits("gemini", { tool_name: "replace", cwd: root, tool_input: { file_path: "cart.js", old_string: "return total", new_string: "return 0" } }, root);
  assert.deepEqual(replace, [{ path: "cart.js", functions: ["applyDiscount"] }]);
  const written = plannedEdits("gemini", { tool_name: "write_file", cwd: root, tool_input: { file_path: join(root, "cart.js"), content: CART.replace("return 1", "return 3") } }, root);
  assert.deepEqual(written, [{ path: "cart.js", functions: ["count"] }]);
  writeFileSync(join(root, "cart.js"), CART.replace("return total", "return total - 1"));
  const done = doneEdits("cursor", { file_path: join(root, "cart.js"), workspace_roots: [root], edits: [{ old_string: "return total", new_string: "return total - 1" }] }, root);
  assert.deepEqual(done, [{ path: "cart.js", functions: ["applyDiscount"] }]);
  assert.deepEqual(plannedEdits("cursor", { tool_name: "Write", workspace_roots: [root], tool_input: { file_path: "cart.js" } }, root),
    [{ path: "cart.js", functions: [], unknown: true }]);           // Cursor did not say what changes: decided after the edit
});

test("answers take each agent's shape", () => {
  assert.deepEqual(denyOut("codex", "no"), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
  assert.deepEqual(denyOut("gemini", "no"), { decision: "deny", reason: "no" });
  assert.deepEqual(denyOut("cursor", "no"), { permission: "deny", agent_message: "no", user_message: "no" });
  assert.deepEqual(contextOut("gemini", "prompt", "hi"), { hookSpecificOutput: { hookEventName: "BeforeAgent", additionalContext: "hi" } });
  assert.deepEqual(contextOut("cursor", "start", "hi"), { additional_context: "hi" });
  assert.deepEqual([allowOut("cursor"), allowOut("claude_code")], [{ permission: "allow" }, null]);
});
