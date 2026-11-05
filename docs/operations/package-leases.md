# Shared package leases

The fleet uses one advisory registry in J's dedicated `t3_agent_coordination`
Postgres database. It is independent of product databases and T3's per-host
SQLite stores. T3 orchestrator v2 manages runs and delegation but does not
currently offer package ownership. Agents use this CLI through their shell
tool, whether they run inside T3 or in standalone Claude/Codex sessions.
No T3 server restart is required.

## Agent workflow

Use the same lowercase `owner/repository` identifier on every host. Package
names are repository-relative paths; `.` claims the entire repository.
Use a stable thread/session ID as `--owner`, including the host if the harness
does not provide a globally unique ID.

```sh
~/.local/bin/t3-agent-lease list --repo flexi767/t3code
~/.local/bin/t3-agent-lease claim --repo flexi767/t3code --package packages/contracts \
  --owner m5:session-id --summary 'Add the checkout contract'
~/.local/bin/t3-agent-lease renew --repo flexi767/t3code --owner m5:session-id \
  --lease UUID_FROM_CLAIM --generation NUMBER_FROM_CLAIM
~/.local/bin/t3-agent-lease release --repo flexi767/t3code --owner m5:session-id \
  --lease UUID_FROM_CLAIM --generation NUMBER_FROM_CLAIM
```

On host `j`, the CLI connects locally; M5 and M3 use existing `ssh j` authentication.
Use the full executable path above: noninteractive agents do not all include
`~/.local/bin` in PATH.
The source launcher is `scripts/agent-lease`; the installed executable works
from any checkout and does not need Rust at invocation time.

Claim each package before editing. Save the returned lease ID and generation.
The default lifetime is 15 minutes; `--ttl` accepts 30–3600 seconds. Renew at
work checkpoints before expiry, including before a long command, and release
on completion or handoff. There is no background heartbeat or automatic
claiming just because an agent starts. Existing sessions must be told to use
the registry; agents launched outside a repository's guidance need the same
instruction in their task.

Exit 2 means another lease overlaps: inspect its owner/summary and choose
another package or coordinate the handoff. Exit 3 means ownership was lost:
stop editing and claim again. Exit 1 is an error or unreachable J: fail closed
for writes to that scope. A list result alone is not permission to edit.

Claims on ancestors and descendants conflict; sibling paths can proceed.
Postgres serializes claim decisions per repository. Expiry uses J's clock.
Each takeover gets a new lease ID and increasing generation, so an old agent's
renew/release cannot change the replacement. The generation fences registry
mutations only: Git and filesystem writes do not enforce these advisory leases.
This is coordination between trusted agents sharing SSH access, not a security
boundary between mutually untrusted agents.

## Install and verify

Run `native/agent-leases/install-db.sh` on J as the existing SSH user `ubuntu`.
It creates the database and a restricted login role if absent, then installs
the schema/function. The role uses Unix-socket peer authentication, can execute
the lease function, and has no direct table write permissions. No Postgres
TCP listener or password is added.

Build `native/agent-leases` with locked Cargo dependencies for each host's
architecture, and install the resulting `t3-agent-lease` into `~/.local/bin`.
Only this helper is installed; T3 app, server and provider CLIs are unchanged.
To disable it, remove the helper from the agents' PATH. Preserve the database
until its claims are no longer needed.

```sh
cargo test --locked --manifest-path native/agent-leases/Cargo.toml
cargo test --locked --manifest-path native/agent-leases/Cargo.toml \
  concurrent_overlapping_claims_have_one_winner -- --ignored
```

Run `leases.test.sql` as database owner in an isolated database with `schema.sql`
installed. It rolls back test rows; it covers overlap, expiry, takeover,
renew/release fencing, and invalid scopes. The ignored Rust integration test
uses two simultaneous SSH requests to the installed registry and releases
its temporary winning lease.
