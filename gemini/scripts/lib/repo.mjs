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
          const repo = typeof config.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(config.repo) ? config.repo : null;
          return { root: dir, project: config.project, repo, edits: config.edits === "block" ? "block" : "warn", summary: config.task_text === "summary" };
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

// owner/name from a GitHub remote URL (https, ssh or ssh://, with or without credentials or .git), else null.
export function repoName(url) {
  const match = /github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url || "");
  return match ? `${match[1]}/${match[2]}` : null;
}

// The GitHub repositories this clone's remotes point at: origin first, then upstream, then the rest. A fork's origin
// is the developer's copy; upstream (or another remote) is usually the team's.
export function remoteRepos(root) {
  const names = (git(root, "remote") || "").split(/\s+/).filter(Boolean);
  const order = [...names.filter((n) => n === "origin"), ...names.filter((n) => n === "upstream"), ...names.filter((n) => n !== "origin" && n !== "upstream")];
  return [...new Set(order.map((n) => repoName(git(root, "remote", "get-url", n))).filter(Boolean))];
}

export function gitRoot(cwd) {
  return git(resolve(cwd || "."), "rev-parse", "--show-toplevel") || null;
}

// The repository, branch and base of the clone at `root`. `repo` chooses the GitHub repository when the caller already
// knows it (the .keelson file names it, or a remote matched a project); else origin's.
export function describe(root, repo = null) {
  repo = repo || repoName(git(root, "remote", "get-url", "origin"));
  let branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
  if (branch === "HEAD") branch = rebasing(root) || branch;            // in the middle of a rebase: the branch being rebased
  const head = git(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD") || "origin/main";
  const base = git(root, "merge-base", "HEAD", head) || null;
  return { repo, branch: branch && branch !== "HEAD" ? branch : null, base, main: head };
}

// What HEAD points at, read from .git without starting git (about 50 ms a process on Windows): the branch's ref
// and its commit. Changes whenever the branch is switched or moves; null when it cannot be read (worktrees,
// packed refs), and callers then ask git.
// The folder holding this checkout's HEAD: `.git`, or for a worktree the folder its `.git` file points at.
function gitDir(root) {
  const dot = join(root, ".git");
  try {
    const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dot, "utf8"));
    return pointer ? resolve(root, pointer[1].trim()) : dot;
  } catch {
    return dot;                                                       // a folder (EISDIR): the usual case
  }
}

function rebasing(root) {
  for (const state of ["rebase-merge", "rebase-apply"]) {
    try {
      const name = readFileSync(join(gitDir(root), state, "head-name"), "utf8").trim();
      if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
    } catch {
      // not this kind of rebase
    }
  }
  return null;
}

export function headStamp(root) {
  try {
    const dir = gitDir(root);
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    const ref = /^ref: (refs\/heads\/.+)$/.exec(head);
    if (!ref) return null;
    const common = existsSync(join(dir, "commondir")) ? resolve(dir, readFileSync(join(dir, "commondir"), "utf8").trim()) : dir;
    return `${head}@${readFileSync(join(common, ...ref[1].split("/")), "utf8").trim()}`;
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
