# Personal fork fleet

For web UI changes on M5, use `scripts/fork-deploy ui`. It builds only
the web client, retains old chunks, and atomically replaces the HTML entry.
Reload the window to use it; running turns, remote hosts, CLI versions and
server processes are unaffected. Changes to contracts, shared runtime or
dependencies require the full rollout below. The signed desktop shell needs
the UI-loader bootstrap once before this command works. UI revisions live in
`~/.t3/ui/<desktop-version>/revision.json`, independently of the server version.

M5 runs the signed desktop app. M3 and J run managed server services. All three
must have the desktop's exact CLI version installed: SSH otherwise tries to
download that version from public releases, where private fork builds do not exist.

From a clean, committed M5 checkout with dependencies installed:

```sh
scripts/fork-deploy fleet --version 0.1.8-preview.20261104.1 --upstream-tag v0.1.8-nightly.20261104.4179
```

Use a new version every time. The script requires both SSH hosts to be reachable,
and can use an existing direct M3 SSH alias by setting `T3CODE_FLEET_M3_SSH_HOST=m3-lan`.
It requires no active T3 turns when switching. It builds serially, verifies upstream
archive checksums and dependency compatibility, preserves the configured local
Apple signing identity, stages complete runtimes, and writes the SSH installation
marker only after each binary reports the expected version. Remote servers switch
before the desktop, and running server versions must match before a completion
receipt is written under `~/.t3/builds/<version>/fleet-complete.json`.
Archive transfers retain partial data for resumption; SSH keepalive checks stop
unresponsive connections instead of leaving a transfer hanging indefinitely.
M5 uploads both runtime packages to J. M3 pulls its Mac package and the staging
helper from J using its existing `j` SSH alias. Each final host verifies its
archive SHA-256 before staging. M5 never sends the large package directly to M3.
Transfer caches use plain tar so rsync can reuse matching native-dependency blocks;
the wire stream is compressed, and the complete tar checksum is checked afterward.

Project folders are off by default because that beta layout disables thread
dragging. Rebuilds preserve existing Labs choices. Change folder settings in the
app; browser and mobile preferences can override defaults on each device.

The launcher compiles `native/fork-deploy` with the locked Rust dependencies.
Full fleet updates send the small Rust crate M5 → J → M3 and compile its host
commands with each host's already-installed toolchain. No Python runtime is used.
Focused helper tests: `cargo test --locked --manifest-path native/fork-deploy/Cargo.toml`.

Backups of the database, previous service definitions and M5 app/preferences are
under `~/.t3/backups/fleet/<version>` on each host. Incomplete staging does not
switch any host. An activation failure is reported as incomplete; inspect the
host and its backup before retrying, especially when database migrations ran.
Never use a public `t3 update` to repair a private fork version.
