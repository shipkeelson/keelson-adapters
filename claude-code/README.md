# Keelson for Claude Code

The Claude Code adapter for Keelson: it tells Keelson what this session is doing and brings other agents' work
into Claude's context, whichever coding agent they use.

- When a session starts, Claude gets a briefing: what this branch should do next, and who else is working here.
- When you give Claude a task that someone is already doing, Claude is told before it writes a line.
- Before each edit, Keelson checks whether another agent has that function, or whether it changed on main since
  this branch's base. Claude is told to work elsewhere, or to merge main first. With `"edits": "block"` in
  `.keelson`, the edit is stopped instead.
- Edits, commits, pushes and the end of the session are reported in the background.

Only file paths, function names and the task text leave your machine, never code. Functions are found locally
(Python, JavaScript, TypeScript); other files are reported as a whole. Keelson being slow, down or not set up
never stops Claude: an edit check waits at most 300 ms.

## Install

```
/plugin marketplace add shipkeelson/keelson-adapters
/plugin install keelson@keelson
```

Claude Code asks for your Keelson API key (Dashboard > API keys, scope `coordination:agent`) and, optionally,
your GitHub login. The plugin also adds Keelson's MCP tools (`check_task`, `branch_status`, `claim`, ...).

Then join each repository to a project once, and commit the file:

```
/keelson:init kp_your_project_id
```

`/keelson:status` shows this branch's next step and the other live work in the repository.

## Develop

The scripts are a copy of [core](../core), shared with the other adapters: change them there, then run
`node sync.mjs`.

```sh
node --test core/test/*.test.mjs        # the scanner, the hooks and each agent's shapes, against a stand-in API
claude plugin validate claude-code
```

The protocol is described in [core/keelson.mjs](../core/keelson.mjs). Settings can also come from the environment:
`KEELSON_API_KEY`, `KEELSON_URL`, `KEELSON_DEVELOPER`.
