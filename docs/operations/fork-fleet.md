# Personal fork fleet

M5 runs the signed desktop app. M3 and J run managed server services. All three
must have the desktop's exact CLI version installed: SSH otherwise tries to
download that version from public releases, where private fork builds do not exist.

From a clean, committed M5 checkout with dependencies installed:

```sh
python3 scripts/rebuild-fleet.py --version 0.1.8-preview.20261104.1 --upstream-tag v0.1.8-nightly.20261104.4179
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

The first two Labs sidebar design options are enabled by default in the fork;
the rollout also enables them in M5's existing desktop preferences. Other Labs
capabilities retain their settings. Browser and mobile preferences can override
the defaults on each device.

Backups of the database, previous service definitions and M5 app/preferences are
under `~/.t3/backups/fleet/<version>` on each host. Incomplete staging does not
switch any host. An activation failure is reported as incomplete; inspect the
host and its backup before retrying, especially when database migrations ran.
Never use a public `t3 update` to repair a private fork version.
