# Keelson adapters

[Keelson](https://shipkeelson.com/gate) is one coordination layer for every coding agent. Every developer keeps the
agent they prefer, and Keelson makes all of them work as one team on the same code: no two agents edit the same
function at once, no agent builds on code that moved on main without merging it first, and a task already being
done is caught before anyone writes a line.

These are the adapters: small plugins that tell Keelson what each agent is doing and bring Keelson's answers back
into the agent. Only file paths, function names and the task text leave your machine, never code. Functions are
found locally (Python, JavaScript, TypeScript). If Keelson is slow or down, the agent carries on.

| Agent | Install |
| --- | --- |
| Claude Code | `/plugin marketplace add shipkeelson/keelson-adapters`, then `/plugin install keelson@keelson` (it asks for your API key) |
| Codex | `codex plugin marketplace add shipkeelson/keelson-adapters`, then `codex plugin add keelson@shipkeelson` |
| Cursor | `npx keelson-watch install cursor` |
| Gemini CLI | `npx keelson-watch install gemini` |
| Anything else, or coding by hand | `npx keelson-watch` in the repository |

Codex, Cursor, Gemini CLI and the watcher read your key from `~/.keelson/config.json`; set it once per machine:

```sh
npx keelson-watch login --key kel_live_... [--developer your-github-login]
```

Then join each repository to a Keelson project: create the project on the
[dashboard](https://shipkeelson.com/dashboard) (Agents > Coordination > Projects) and commit the `.keelson` file it
gives you at the repository's root. Everyone who opens that repository with an adapter joins the project.

## How it works

Every adapter speaks one small protocol ([docs](https://github.com/shipkeelson/keelson-adapters/blob/main/core/keelson.mjs)):
`session.start`, `task.declare`, `edit.intent` before each edit, `edit.done`, `git.commit`, `git.push`, `heartbeat`
and `session.end`, answered with `allow`, `wait`, `sync_main`, `deny`, `stop` and the like. Writing an adapter for
another agent means mapping its hook input to these events (see `core/lib/vendors.mjs`).

`core/` is the shared implementation; `node sync.mjs` copies it into each adapter, which must stand alone when
installed. Tests: `node --test core/test/*.test.mjs watch/test/*.test.mjs`.

Licensed under the Apache License 2.0. The Keelson service itself is operated by ShipKeelson.
