---
description: Join this repository to a Keelson project by writing its .keelson file
argument-hint: <project ID, e.g. kp_7f3k9q2m4x8wz1ab>
---

Join this repository to the Keelson project `$ARGUMENTS`.

1. Check that `$ARGUMENTS` looks like a Keelson project ID: `kp_` followed by 8 to 40 letters or digits. If it does not, tell the user to copy the ID from the Keelson dashboard (Agents > Coordination > Projects) and stop.
2. Find the repository root with `git rev-parse --show-toplevel`.
3. Write a file named `.keelson` at that root containing exactly:

   ```json
   {"project": "$ARGUMENTS", "version": 1}
   ```

   If a `.keelson` file already exists with a different project, show both IDs and ask the user before replacing it.
4. Tell the user to commit `.keelson` so everyone who opens this repository, with any coding agent, joins the same project; and that the repository must also be added to the project on the dashboard. Optional settings in the same file: `"edits": "block"` stops an edit when another agent has that code (the default, `"warn"`, only tells Claude), and `"task_text": "summary"` sends only the first line of each task.
