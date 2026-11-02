# Keelson for Gemini CLI

The Gemini CLI adapter for Keelson, built on Gemini CLI's hooks.

```sh
npx keelson-watch login --key kel_live_...
npx keelson-watch install gemini        # adds Keelson to ~/.gemini/settings.json
```

- **`SessionStart`:** a briefing in the agent's context. **`BeforeAgent`:** the task is checked for duplicates.
- **`BeforeTool` (`write_file|replace`):** the functions the edit changes are checked; with `"edits": "block"` in
  `.keelson` the edit is refused (`decision: deny`). Gemini CLI cannot add context before a tool runs, so in the
  default warn mode the advice is added to the tool's result (`AfterTool`).
- **`AfterTool`:** edits, commits and pushes reported; **`SessionEnd`:** claims released.

Gemini CLI fingerprints project hooks and asks before running changed ones. Note: Google replaced Gemini CLI with
Antigravity CLI for unpaid and Google One users in June 2026; this adapter is for those still on Gemini CLI.
The scripts are a copy of [core](../core) (`node sync.mjs`).
