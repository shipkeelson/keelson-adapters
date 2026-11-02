---
description: Show what Keelson knows about this branch and the other agents working on this repository
---

Use the `keelson` MCP server's tools to report on this repository.

1. Find the repository as `owner/name` from `git remote get-url origin`, and the branch from `git rev-parse --abbrev-ref HEAD`.
2. Call `branch_status` with that `repo` and `branch`.
3. Call `in_flight` with that `repo` and `branch` to see other live work.
4. Tell the user, briefly: the next step for this branch and why, which other agents or people are working here and on what, and anything that overlaps this branch's code. If the `keelson` tools are missing, say the Keelson plugin needs its API key (run /plugin, choose keelson, configure).
