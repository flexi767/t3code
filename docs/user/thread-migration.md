# Moving threads and importing older history

## Move a thread to another machine

Connect both environments, then right-click a thread and choose **Move to another machine…**.
Select a project on the destination. Each moved thread gets its own checkout, even when it shared
one with its parent on the source. Archived descendants stay archived, and deleted descendants are
omitted. Fork ancestor snapshots are retained in the destination's Archive
so inherited history can still be read. The command palette and mobile thread menu offer
the same action when both servers support it.

Finish the thread and its subagents first. Commit and push workspace changes: the destination
gets a new worktree at the saved commit, not a copy of uncommitted files. Install dependencies
or run the project's setup script in that worktree before continuing.

The move copies saved messages, activity, attachments, and local subthreads. The first new turn
starts a fresh provider conversation using a [portable handoff](./portable-handoffs.md); a live
provider process and Git checkpoints do not move. The selected provider must be enabled on the
destination. Transfers allow up to 32 MiB of attachments and about 47 MiB of compressed saved data.

T3 Code archives the original only after the destination confirms receipt. It remains recoverable
in Archive. If the source changes or disconnects during the move, the destination copy remains
saved and the source stays available. Retry an import failure from the same dialog to reconcile
its saved copy. If a completed copy reports that the source was kept, review that source and archive
it manually when its remaining work is finished.

## Threads from older T3 Code versions

On your first V2 launch, T3 Code automatically copies your V1 database (`state.sqlite`) to `statev2.sqlite` in the same data directory and migrates it. V1 and V2 stay independent afterward (changes in one do not sync to the other), while settings, attachments, and workspace files remain shared.

## What migrates

- **Included**: Thread metadata (title, project, provider/model, modes, branch/worktree, archive/settle/snooze/pin state, linked PR), user/assistant messages, timestamps, and supported attachments. On desktop, first launch also copies V1 stashed prompts, drafts, layout, and theme (browser cookies/caches do not carry over).
- **Not included**: Live provider sessions, old run records, checkpoints/diffs, tool activity, approvals, and proposed plan history.

## Continuing a migrated thread

Sending your first message starts a fresh provider session using the [portable handoff budget](./portable-handoffs.md). Omitted text remains saved in the thread and readable by the agent, though for long or critical threads it's worth restating key constraints—or starting a fresh thread with a short summary.

## Keeping a recovery copy

T3 Code does not have a whole-thread export command. Before a major server update, stop the server and back up your `userdata` directory (`~/.t3/userdata` by default, or `<base-dir>/userdata`).

If a migrated transcript is missing, inspect your backup read-only without pointing a server at it:

```sh
sqlite3 -readonly /path/to/recovery-copy/state.sqlite
```

```sql
-- List legacy threads
.headers on
.mode tabs
SELECT thread_id, title, updated_at
FROM projection_threads
ORDER BY updated_at DESC;

-- Print one transcript
SELECT role, text, created_at
FROM projection_thread_messages
WHERE thread_id = '<thread-id>'
  AND role IN ('user', 'assistant')
ORDER BY created_at, message_id;
```
