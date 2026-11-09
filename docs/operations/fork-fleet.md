# Personal fork fleet

For web UI changes on M5, use `scripts/fork-deploy ui`. It builds only
the web client, retains old chunks, and atomically replaces the HTML entry.
Reload the window to use it; running turns, remote hosts, CLI versions and
server processes are unaffected. Changes to contracts, shared runtime or
dependencies, or the desktop shell, require the full rollout below. The signed
desktop shell needs the UI-loader bootstrap once before this command works. UI
revisions live in `~/.t3/ui/<desktop-version>/revision.json`, independently of the
server version. Previous entry pages are kept in `~/.t3/ui/<desktop-version>/backups`.
Delete `~/.t3/ui/<desktop-version>/client` and reload to return to the bundled UI.

M5 runs the signed desktop app. M3 and J run managed server services. All three
must have the desktop's exact CLI version installed: SSH otherwise tries to
download that version from public releases, where private fork builds do not exist.

From a clean, committed M5 checkout with dependencies installed:

```sh
scripts/fork-deploy fleet --version 0.1.8-preview.20261104.1 --upstream-tag v0.1.8-nightly.20261104.4179
```

Use a new version every time. The script requires both SSH hosts to be reachable,
and can use an existing direct M3 SSH alias by setting `T3CODE_FLEET_M3_SSH_HOST=m3-lan`.
It builds serially, verifies upstream
archive checksums and dependency compatibility, preserves the configured local
Apple signing identity, stages complete runtimes, and writes the SSH installation
marker only after each binary reports the expected version. Remote servers switch
before the desktop, and running server versions must match before a completion
receipt is written under `~/.t3/builds/<version>/fleet-complete.json`.

Full builds require `T3CODE_RELAY_URL`, `T3CODE_CLERK_PUBLISHABLE_KEY` and
`T3CODE_CLERK_CLI_OAUTH_CLIENT_ID`. The helper reads these from the environment,
falling back to `~/.t3/fork-connect-public.json` with the same keys, where
`T3CODE_CLERK_JWT_TEMPLATE` is optional but web clients lose T3 Connect without it.
That file contains public build configuration, not login credentials. Missing
values fail before building: a signed app without them can run locally while
silently leaving every phone unable to connect after a restart.

## Activating around running agents

`fleet-stage`, with the same version and upstream flags, builds and stages all
three hosts without activating. Then choose how to switch, with `fleet-activate
--version VERSION` or the same flags on `fleet`:

| Flags                                 | Behavior                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| none                                  | Refuses unless every host is idle.                                                  |
| `--when-idle-timeout SECONDS`         | Waits for idle, then pauses new turns and switches. On timeout it switches nothing. |
| `--when-idle-timeout SECONDS --force` | The same, but on timeout it restarts anyway.                                        |
| `--force`                             | Restarts now.                                                                       |

The wait is at most four hours, and new turns stay allowed during it. When every
host looks idle, the rollout pauses new turns everywhere, confirms that no turn started
in between, and switches. If one did, it allows turns again and keeps waiting, so a
fleet that never goes idle times out without switching. While paused, new sends are
refused with a message saying so, and due scheduled tasks wait. A timeout, Ctrl+C, or `scripts/fork-deploy
fleet-activate-cancel` from another terminal ends the rollout without switching
anything. If the rollout itself dies during the switch, each host's pause expires by
itself within 15 minutes. A host only enforces the pause once it runs a build that
has it, so the first rollout to that build still needs an idle check at switch time.

A forced restart relies on **Continue threads after restarts**. It prints the
interrupted threads and records them in `fleet-complete.json`. Check them: a resumed
agent may re-run a command that had only partly finished, such as a migration or
a push. Threads shown as `[waiting]` need you before they continue.

A process inside a T3 turn dies with the restart it requests, and its own turn
keeps the fleet busy, so activation refuses to run there. Add `--detach` with
`--when-idle-timeout` or `--force` to run in the background, logging to
`~/.t3/logs/fleet-VERSION.log`, then end the turn. Only Claude and Codex set the
variable this check reads; from another provider's turn, always use `--detach`.
Never wrap activation in `launchctl submit`: submitted jobs are KeepAlive, so the
activator reruns every 10 seconds, even after it succeeds, and each rerun can quit the app.

If M3 is unreachable, `T3CODE_FLEET_SKIP_M3=1` rolls out to M5 and J only. The desktop
cannot connect to M3 until a later rollout, with a new version, reaches it.

## Keeping agents running through a switch

With **Keep agents running across restarts** on (Settings → Maintenance, per host, off by
default), Claude and Codex sessions run in a separate holder process, so a restart no longer
interrupts their turns. Threads on a live holder don't count as busy, so plain `fleet` and
`fleet-activate` switch without waiting for them, and `--force` doesn't list them as
interrupted. Other providers still need one of the options above.

Holders are registered under `<state dir>/agent-holders/`. A holder from an older version
finishes the turn it has and exits; the next turn opens on the new version. A held agent can
outlive `t3 service stop` or quitting the app: it finishes its turn, and the holder exits after
30 quiet minutes with no server. To stop one now, send SIGTERM to the pid in its file.

## Failure and rollback

A server host that doesn't report the new version within five minutes is rolled
back automatically: its previous service definition, CLI link and database backup
(the first snapshot, taken after the old server stopped) return, and the old version
restarts. M5 does the same with its previous app. Other hosts are not rolled back, so
the error can leave the fleet on mixed versions. Retrying with `fleet-activate` is safe:
an installed fleet is left alone and a host already on the version is only verified.
`fleet` itself needs a new version.

These are the deploy tool's rollbacks. M3 and J run `t3 serve`
directly, without the launcher described in
[server updates](../internals/server-updates.md), so its trial boot and rollback
do not apply here.

## Transfers

Archive transfers retain partial data for resumption; SSH keepalive checks stop
unresponsive connections instead of leaving a transfer hanging indefinitely.
M5 uploads both runtime packages to J. M3 pulls its Mac package and the staging
helper from J using its existing `j` SSH alias. Each final host verifies its
archive SHA-256 before staging. M5 never sends the large package directly to M3.
Transfers use compressed, whole-file rsync: delta updates of the cached tar have
failed verification between these hosts. The complete tar checksum is checked
before staging on each final host. Staged archives are deleted from `/tmp`, which
is RAM-backed on J.

Project folders are off by default because that beta layout disables thread
dragging. Rebuilds preserve existing Labs choices. Change folder settings in the
app; browser and mobile preferences can override defaults on each device.

The launcher compiles `native/fork-deploy` with the locked Rust dependencies.
Full fleet updates send the small Rust crate M5 → J → M3 and compile its host
commands with each host's already-installed toolchain. No Python runtime is used.
Focused helper tests: `cargo test --locked --manifest-path native/fork-deploy/Cargo.toml`.

Backups of the database, previous service definitions and M5's app are under
`~/.t3/backups/fleet/<version>` on each host. Incomplete staging does not switch
any host. Never use a public `t3 update` to repair a private fork version.
