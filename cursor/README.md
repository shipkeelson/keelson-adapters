# Keelson for Cursor

The Cursor adapter for Keelson, built on Cursor's agent hooks.

```sh
npx keelson-watch login --key kel_live_...
npx keelson-watch install cursor        # adds Keelson to ~/.cursor/hooks.json
```

What it can do is set by Cursor's hooks:

- **`sessionStart`:** a briefing in the agent's context.
- **`preToolUse` (Write):** when the edit's file and text are in the hook input, Keelson checks the functions it
  changes and can refuse the edit (`permission: deny`) when the project blocks. Cursor's documentation does not
  describe the Write tool's input, so where only the file is known the check moves to after the edit.
- **`afterFileEdit`:** the functions edited are claimed and reported; if another agent held one, the agent hears it
  with its next tool result (`postToolUse`'s `additional_context`).
- **`beforeSubmitPrompt`:** the task is checked for duplicates; Cursor cannot add context there, so the answer
  arrives with the next tool result.
- **`afterShellExecution`:** commits and pushes; **`sessionEnd`:** claims released.

Cloud agents do not run user-level hooks; they are seen through the GitHub App. Hook commands run through
PowerShell on Windows. The scripts are a copy of [core](../core) (`node sync.mjs`).
