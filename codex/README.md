# Keelson for Codex

The Codex adapter for Keelson, built on Codex's lifecycle hooks: the same answers Claude Code gets, so a Codex
agent and a Claude Code agent on one project never edit the same function at once.

- **Session start:** a briefing in Codex's context.
- **Task (`UserPromptSubmit`):** a task someone is already doing is flagged before Codex writes a line.
- **Before each `apply_patch` (`PreToolUse`):** Keelson reads the patch locally, works out which functions each
  file's hunks touch, and tells Codex when another agent holds one or it changed on main. With `"edits": "block"`
  in `.keelson` the patch is refused instead.
- **After a patch or a `git commit` / `git push` (`PostToolUse`):** reported, and anything Keelson has said since,
  such as "main just changed code you are editing", is added to Codex's context.
- **Session end (`SessionEnd`):** this session's claims are released.

Only file paths, function names and the task text leave your machine, never code.

## Install

As a plugin, from this repository's marketplace (`.agents/plugins/marketplace.json`):

```sh
codex plugin marketplace add shipkeelson/keelson-adapters
codex plugin add keelson@shipkeelson
```

or without the plugin system, into `~/.codex/hooks.json`:

```sh
npx keelson-watch install codex
```

Codex plugins have no settings of their own, so sign in once per machine:

```sh
npx keelson-watch login --key kel_live_... [--developer your-github-login]
```

Codex asks you to review and trust new hooks (`/hooks`). Keelson's MCP tools can be added with
`codex mcp add keelson --url https://api.shipkeelson.com/mcp --bearer-token-env-var KEELSON_API_KEY`.

The scripts are a copy of [core](../core) (`node sync.mjs`).
