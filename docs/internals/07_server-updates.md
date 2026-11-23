# Server updates

## Launcher ownership and compatibility

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime selected by systemd,
launchd, or Task Scheduler and is the only runtime writer of durable service state. Server children
request updates over inherited IPC and never rewrite their service definition. Foreground CLI
processes do not self-update.

Remote updates replace only the server child, not the launcher, so every existing background service
lags behind after a launcher-protocol bump. Keep new server runtimes compatible with the previous
launcher protocol unless impossible, and validate protocol compatibility during preflight.

Installations use exact versions and stage/preflight before publishing an immutable runtime so
restarts never depend on npm cache eviction or a moving tag.

## Commit boundary and database rollback

1. Record the pending update durably (atomic rename + fsync) before stopping the old child.
2. Refuse the update if a database snapshot will not fit on disk. After the old child exits, snapshot
   SQLite (main, WAL, SHM) once per update so failed trial migrations are reversible without down
   migrations. Never overwrite that snapshot on retry. Files outside SQLite (such as attachments)
   are outside this rollback boundary.
3. Start the new runtime as a trial. It must finish migrations, acquire fallible dependencies, bind
   HTTP, and hold long-running roots at the activation gate before reporting `prepared`.
4. Only after the launcher commits the new version durably and replies `committed` may the child
   release activation gates and accept work. A failed or timed-out trial stops and restores the
   snapshot before booting the old version.

## Client acknowledgement

An accepted update RPC is only pending. Clients correlate the launcher's update ID with the
reconnected ready state to distinguish commit from rollback. Desktop updates use a two-phase handoff
(prepare token while connected, commit after receiving it) because installing stops the bundled
backend.

## Pausing new turns

Fork rollouts pause new turns with a hold file in the state directory, because the
deployment helper runs outside the server and may reach it only over SSH. The check runs
inside the commit's `BEGIN IMMEDIATE`, and the helper takes that write lock once after
writing the hold. A commit that passed the check therefore finishes before the helper
counts active runs, and every later commit sees the hold. Checking outside the transaction
would let a turn start after the count reported idle. The helper waits for idle without the
hold and takes it only to confirm and switch, so a busy fleet never blocks new turns for the
whole wait; a turn found by the confirming count releases the hold and the wait resumes.

A launch checks the hold before creating its thread, so a refused first send leaves only
the client's draft and any later retry can create the thread. A hold that starts just after the
thread is created leaves it empty, and a client that has not heard about it may retry with a
new command. That launch adopts the empty thread, and a launch's first message is refused
unless the thread is still empty, so only one attempt can start a turn. A held command writes no rejection receipt, because scheduled and limit-recovery commands
reuse stable IDs and must work once the hold ends. Work an admitted turn depends on stays
open, since refusing it would fail that turn. An expired or unreadable hold counts as open
so that a dead rollout cannot stop turns indefinitely.

## Keeping agents alive across restarts

With `keepAgentsRunningAcrossRestarts`, Claude and Codex sessions run in a detached
[holder process](../../apps/server/src/agentHolder/holderMain.ts) that the server reaches over a
Unix socket. The boundary is the adapter's session runtime rather than the provider's stdio:
both adapters keep turn state in memory, and neither CLI can be re-attached mid-protocol, so
holding only the child process would still lose the turn. Other providers stay in the server
and use the recovery below.

Recovery must never run on a thread a holder still owns, or two agents work in one worktree.
[Reattachment](../../apps/server/src/orchestration-v2/HeldSessionRecovery.ts) therefore runs
before recovery, and a session that can't prove its run reached the provider is stopped so that
recovery has one owner. If a holder is unreachable, its threads take the normal recovery path.

The run consumer's routing state lives only in memory, so the holder retains each session's
events and a new consumer replays them. Events the last server finished rebuild state without
being ingested; the rest ingest normally. Acknowledgement is at-least-once: a hard kill can
re-ingest the last 100 ms, which converges because projections upsert. Retained snapshot events
keep only their newest state, so a replay may skip intermediate states.

Agents reach MCP through a [proxy in the holder](../../apps/server/src/agentHolder/mcpHoldingProxy.ts).
Real CLIs fail a call made during the outage and stay disconnected, and Codex fixes its MCP URL
at thread start, so the proxy holds requests the server never received and re-creates sessions
the restarted server forgot. It never repeats a call whose response was cut, since the tool may
have run. Credentials return from the holder at reattachment because the registry is in memory.

Linux service stops kill the whole cgroup, so the holder starts through `systemd-run --scope`
there. A holder doesn't use agent scopes: the server's startup sweep stops what is in its slice.

## Recovering interrupted threads

- On startup, retire effects tied to the lost process before admitting new work.
- Persist restart-continuation intent in the durable outbox and wait for activation before running
  it so slow providers never delay readiness or the launcher's commit boundary.
- Cap consecutive crash recoveries per unfinished turn so a crashing turn cannot loop forever.
- Never auto-continue a turn that is archived, settled, snoozed, user-stopped, or waiting on a
  blocking user action (approval, question, or secret).
