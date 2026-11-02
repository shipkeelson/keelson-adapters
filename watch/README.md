# keelson-watch

The Watcher tier: any coding agent without a Keelson adapter (Aider, Cline, Windsurf, an agent we have never
heard of), or a person coding by hand, becomes visible to every other agent on the project.

```sh
npx keelson-watch login --key kel_live_... [--developer your-github-login]
npx keelson-watch [folder] [--agent Aider] [--sync] [--quiet]   # in this terminal
npx keelson-watch start [folder]                                # in the background (log in ~/.keelson/watch/)
npx keelson-watch stop [folder]
npx keelson-watch status [folder]                               # who is working in this project, on what
```

Answers that matter (another agent has the function you just edited, main changed it, the code you waited for is
free) are printed and also shown as a desktop notification (macOS, Linux with `notify-send`, Windows); `--quiet` or
`KEELSON_NOTIFY=0` turns notifications off.

It watches the repository folder (files git ignores are skipped) and git itself:

- Each saved file is compared with what it held before, functions are found locally, and they are claimed and
  reported, so other agents are told while this one works. Keelson's answer (another agent has that function,
  main changed it) is printed in the terminal; the Watcher cannot stop another program's edit.
- Commits, pushes and branch switches are reported from the repository's own files.
- With a project coordinator, messages arrive as they happen ("main just changed code you are editing");
  otherwise they come with each answer and heartbeat (every 2 minutes).
- `--sync` merges main into the branch when Keelson says the code being edited moved on main, only when the
  working tree is clean; otherwise it prints what to run.

`install codex|cursor|gemini` adds Keelson's hooks to that agent for this user (see each adapter's README).
Only file paths, function names and task text leave the machine, never code. Needs Node 20 or later.
