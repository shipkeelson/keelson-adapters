// The repository a session works in: its Keelson project (the `.keelson` file), GitHub name, branch and base.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const PROJECT = /^kp_[A-Za-z0-9]{8,40}$/;

export function git(cwd, ...args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
  } catch {
    return "";
  }
}

// The nearest `.keelson` at or above `cwd`: { root, project, edits } or null. `edits` is "warn" (default) or "block".
export function findProject(cwd) {
  let dir = resolve(cwd || ".");
  for (;;) {
    const file = join(dir, ".keelson");
    if (existsSync(file)) {
      try {
        const config = JSON.parse(readFileSync(file, "utf8"));
        if (typeof config.project === "string" && PROJECT.test(config.project)) {
          return { root: dir, project: config.project, edits: config.edits === "block" ? "block" : "warn", summary: config.task_text === "summary" };
        }
      } catch {
        // an unreadable file is the same as none: Keelson stays out of the way
      }
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// owner/name from a GitHub remote URL (https or ssh), else null.
export function repoName(url) {
  const match = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

export function describe(root) {
  const repo = repoName(git(root, "remote", "get-url", "origin"));
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  const head = git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") || "origin/main";
  const base = git(root, "merge-base", "HEAD", head) || null;
  return { repo, branch: branch && branch !== "HEAD" ? branch : null, base, main: head };
}

// What HEAD points at, read from .git without starting git (about 50 ms a process on Windows): the branch's ref
// and its commit. Changes whenever the branch is switched or moves; null when it cannot be read (worktrees,
// packed refs), and callers then ask git.
export function headStamp(root) {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const ref = /^ref: (refs\/heads\/.+)$/.exec(head);
    if (!ref) return null;
    return `${head}@${readFileSync(join(root, ".git", ...ref[1].split("/")), "utf8").trim()}`;
  } catch {
    return null;
  }
}

// A path inside the repository, with forward slashes; null when outside it.
export function inside(root, path) {
  if (!path) return null;
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith("..") || resolve(rel) === rel) return null;
  return rel.split(sep).join("/");
}
