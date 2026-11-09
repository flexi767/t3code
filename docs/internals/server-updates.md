# Server updates

A [stable launcher](../../apps/server/src/serviceLauncher.ts) owns the runtime
selected by systemd or launchd. It is the only runtime writer of durable service
state. Server children request updates over inherited IPC; they never rewrite
their service definition or select their own replacement. Local service commands
may replace the launcher and state while the service is stopped. Foreground CLI
processes do not self-update.

Exact-version installs keep restarts independent of npm cache eviction or a moving
release tag. Installation and preflight happen in staging before publishing an
immutable runtime. Preflight checks the launcher protocol because a target that
needs new rollback guarantees cannot safely run under an older launcher. Upgrading
that launcher requires a local service update.

## Commit boundary

The launcher durably records the pending update before acknowledging it, then
stops the old child and starts the target as a trial. Service-state writes use
same-directory replacement with file and directory fsync. Invalid state stops
startup rather than guessing which runtime to boot.

The trial must finish migrations, acquire dependencies, bind HTTP, and park every
long-running root at the activation gate before reporting `prepared`. The launcher
then commits the target version durably and replies `committed`. Only then may the
child release its gates, accept commands, and publish ready. Keep fallible startup
acquisitions before this boundary. A listener alone does not prove the runtime is
ready to commit.

A failed or timed-out trial returns to the old version. After commit, the target
is authoritative and the service manager's ordinary restart policy applies.

The prepared deadline is long because migrations can scale with the database
and block the trial's main thread, so it cannot report progress. A missed
deadline restores the snapshot, and the retry pays the same cost again. A
crashed trial is caught when it exits; the deadline bounds only a stuck one.
Client update waits must outlast the deadline, or a slow update shows as failed.

## Database rollback

Before stopping the old child, the launcher refuses an update whose snapshot will
not fit on disk, so a full disk does not cause an outage. After the old child
exits, the launcher snapshots SQLite's main file, WAL, and shared-memory file. This makes trial migrations reversible without down
migrations. The snapshot is made once per update and survives launcher restarts;
replacing it during a retry could capture changes from the failed trial.

Rollback stops the trial before restoring. A durable restore marker makes an
interrupted restore finish before either version boots. Keep the snapshot until
commit, or until both restoration and the terminal rollback state are durable.
Attachments and other files outside SQLite are outside this rollback boundary.

## Client acknowledgement

An accepted update is still pending. Clients correlate the launcher's update ID
with the ready event after reconnecting, then check the outcome and target version.
A reconnect alone cannot distinguish successful replacement from rollback. Older
servers without an update ID retain version-only correlation.

Desktop updates have a separate two-phase handoff because installing the app stops
its bundled backend. Preparation returns a token while the connection is alive;
the client commits that token only after receiving it. Otherwise backend shutdown
could lose the only successful RPC result. The client must then observe the
prepared version after reconnecting. If installation fails, desktop restarts the
stopped backends and replays the failure for the same token.

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

Restart continuation is an environment-owned preference, on by default. A
`settings.json` that fails to decode turns it off, since the file may hold an
opt-out. The
[v2 recovery service](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts)
requires matching durable run, provider thread, session, and native resume identity.
Queued runs never started, so recovery holds them and continues the run they wait
behind. A settled run qualifies only when the restart cancels work the agent waits on
(a subagent, a background task, or a shell or monitor the agent marked with
`t3_background_wait`) and its session was live, so stale records from an older crash
never wake it. Its continuation prompt is the note of what will not report back. An
unmarked shell or monitor does not wake a settled run: most are dev servers and their
watchdogs that nobody waits on, so that note waits for the next user message.

Recovery retires effects tied to the lost process and records continuation intent
in the durable outbox. That intent survives another restart before provider startup.
Continuation effects wait for activation; a slow provider must not delay the server's
readiness or the launcher's commit boundary. Graceful shutdown captures intent before
closing providers, then reconciles after ingestion has stopped so a late completion
cannot be overwritten by a stale cancellation.

The [continuation handler](../../apps/server/src/orchestration-v2/RestartContinuation.ts)
rechecks the preference, provider selection, newer user work, a stop the user requested,
and maintenance turns such as `/compact` before dispatching. Intent and delivery both
refuse a thread that is archived, settled, or still snoozed, a cut turn whose provider
turn already ended, and a run waiting on the user: an approval, question, or secret that was pending,
or that recovery closed on the cut turn. Message-capable questions stay answerable, so
they do not block. Delivery also stops after three consecutive continuations in one
`restartContinuationOfRunId` chain, so a turn that crashes the server cannot loop. Stable
command and message IDs prevent duplicate submissions after an outbox retry. Codex
resumes without adding provider prompt text unless the turn lost background work;
other adapters receive the continuation message through their normal turn path.

Delegated tasks (`delegate_task` child threads) are reconciled as their own threads,
never as the parent's background work. The orchestrator settles child results and
completion deliveries in a startup pass after reconciliation, because the terminal-run
listener ignores reconciliation's cancellations. A cancelled child whose restart
continuation is still pending in the outbox is not a result yet; the continuation's run
settles it, or the handler settles it when it declines to continue. Schedulers wait for
activation so they cannot start runs that reconciliation would then cancel.
