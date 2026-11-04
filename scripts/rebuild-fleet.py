#!/usr/bin/env python3
"""Build and stage one signed fork version on M5, M3 and J before activating it."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
import urllib.request


def run(*args, **kwargs):
    return subprocess.run([str(x) for x in args], check=True, **kwargs)


def output(*args):
    return subprocess.check_output([str(x) for x in args], text=True).strip()


def version(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+-(?:preview|nightly)\.\d{8}\.\d+", value):
        raise ValueError("Use an exact, unique preview or nightly version.")
    return value


def idle():
    database = Path.home() / ".t3/userdata/statev2.sqlite"
    if not database.exists():
        return
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as db:
        count = db.execute("SELECT count(*) FROM orchestration_v2_projection_runs "
                           "WHERE status IN ('running','preparing','waiting')").fetchone()[0]
    if count:
        raise RuntimeError(f"{count} active turns; finish them before switching versions")


def runtime(ver):
    return Path.home() / ".t3/runtime/versions" / version(ver)


def stage(ver, archive):
    target = runtime(ver)
    if target.exists():
        raise RuntimeError(f"Version already exists: {target}; use a new version")
    target.mkdir(parents=True)
    # Archives are built locally from checksum-verified upstream runtime assets.
    run("tar", "-xzf", archive, "--strip-components=1", "-C", target)
    if output(target / "t3", "--version") != f"t3 v{ver}":
        raise RuntimeError("Staged CLI version does not match the desktop")
    if not (target / "client/index.html").is_file():
        raise RuntimeError("Staged runtime has no web client")
    # The SSH launcher checks this exact marker before trying a public download.
    (target / ".install-complete").write_text(ver + "\n")
    print(f"Staged {ver}", flush=True)


def backup(ver):
    idle()
    dest = Path.home() / ".t3/backups/fleet" / ver
    dest.mkdir(parents=True, exist_ok=True)
    database = Path.home() / ".t3/userdata/statev2.sqlite"
    if database.exists():
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as source:
            with sqlite3.connect(dest / "statev2.sqlite") as copy:
                source.backup(copy)
    return dest


def activate(ver):
    target = runtime(ver)
    if (target / ".install-complete").read_text().strip() != ver:
        raise RuntimeError("Unverified runtime; activation refused")
    saved = backup(ver)
    mac = sys.platform == "darwin"
    service = (Path.home() / "Library/LaunchAgents/com.t3tools.t3code.service.plist"
               if mac else Path.home() / ".config/systemd/user/t3code.service")
    original = service.read_text()
    replacement, count = re.subn(r"/runtime/versions/[^/\s<]+/t3", f"/runtime/versions/{ver}/t3", original)
    if count != 1:
        raise RuntimeError("Expected exactly one managed service executable")
    shutil.copy2(service, saved / service.name)
    if mac:
        run("launchctl", "bootout", f"gui/{os.getuid()}", service)
    service.write_text(replacement)
    launcher = Path.home() / ".local/bin/t3"
    next_link = launcher.with_name("t3.fleet-next")
    next_link.symlink_to(target / "t3")
    next_link.replace(launcher)
    if mac:
        run("launchctl", "bootstrap", f"gui/{os.getuid()}", service)
    else:
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "restart", "t3code")


def verify(ver):
    if output(Path.home() / ".local/bin/t3", "--version") != f"t3 v{ver}":
        raise RuntimeError("Launcher version mismatch")
    if (runtime(ver) / ".install-complete").read_text().strip() != ver:
        raise RuntimeError("SSH runtime marker mismatch")
    deadline = time.monotonic() + 90
    while True:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3773/.well-known/t3/environment", timeout=4) as response:
                descriptor = json.load(response)
            if descriptor["serverVersion"] == ver:
                print(f"Verified {descriptor['label']}: {ver}", flush=True)
                return
        except (OSError, ValueError):
            pass
        if time.monotonic() > deadline:
            raise RuntimeError("Running server did not reach the required version")
        time.sleep(2)


def remote(host, helper, *args):
    command = shlex.join(["python3", helper, *map(str, args)])
    run("ssh", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10",
        "-o", "ServerAliveCountMax=3", ssh_route(host), command)


def ssh_route(host):
    return os.environ.get("T3CODE_FLEET_M3_SSH_HOST", host) if host == "m3" else host


def distribute(ver, archives):
    helper = f"/tmp/t3-fleet-{ver}.py"
    ssh_options = ["-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=3"]
    transport = "ssh -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3"
    run("scp", *ssh_options, __file__, f"{ssh_route('j')}:{helper}")
    remote_archives = {}
    for platform in ["linux-x64", "darwin-arm64"]:
        destination = f"/tmp/t3-fleet-{ver}-{platform}.tar.gz"
        run("rsync", "-a", "--partial", "--inplace", "-e", transport,
            archives[platform], f"{ssh_route('j')}:{destination}")
        remote_archives[platform] = destination
    # M3 already trusts/authenticates to its `j` alias. Package bytes travel J -> M3.
    for source in [helper, remote_archives["darwin-arm64"]]:
        run("ssh", *ssh_options, ssh_route("m3"), shlex.join([
            "rsync", "-a", "--partial", "--inplace", "-e", transport,
            f"j:{source}", "/tmp/",
        ]))
    for host, platform in [("j", "linux-x64"), ("m3", "darwin-arm64")]:
        expected = hashlib.file_digest(archives[platform].open("rb"), "sha256").hexdigest()
        # Verify the archive again on the final host before extracting/installing it.
        check = f"import hashlib; from pathlib import Path; assert hashlib.file_digest(Path({remote_archives[platform]!r}).open('rb'), 'sha256').hexdigest() == {expected!r}, 'Fleet archive checksum mismatch'"
        run("ssh", *ssh_options, ssh_route(host), shlex.join(["python3", "-c", check]))
        remote(host, helper, "host-stage", "--version", ver, "--archive", remote_archives[platform])
    return helper


def rebuild(ver, upstream, disable_project_folders=False):
    root = Path(__file__).resolve().parent.parent
    os.chdir(root)
    if output("git", "status", "--porcelain", "--untracked-files=normal"):
        raise RuntimeError("Commit the source changes before rebuilding")
    run("git", "merge-base", "--is-ancestor", upstream, "HEAD")
    # Reuse native dependencies only from the exact upstream dependency set.
    for file in ["pnpm-lock.yaml", "pnpm-workspace.yaml"]:
        run("git", "diff", "--exit-code", upstream, "--", file)
    base_package = json.loads(output("git", "show", f"{upstream}:apps/server/package.json"))
    package = root / "apps/server/package.json"
    if json.loads(package.read_text())["dependencies"] != base_package["dependencies"]:
        raise RuntimeError("Server dependencies differ from the upstream runtime archives")
    idle()
    for host in ["m3", "j"]:
        run("ssh", "-o", "ConnectTimeout=8", ssh_route(host), "true")
    run("ssh", "-o", "ConnectTimeout=8", ssh_route("m3"),
        "ssh -o BatchMode=yes -o ConnectTimeout=8 j true")
    builds = Path.home() / ".t3/builds" / ver
    builds.mkdir(parents=True, exist_ok=True)
    base_version = upstream.removeprefix("v")
    names = [f"t3-{base_version}-{platform}.tar.gz" for platform in ["darwin-arm64", "linux-x64"]]
    run("gh", "release", "download", upstream, "--repo", "pingdotgg/t3code", "--dir", builds,
        "--pattern", names[0], "--pattern", names[1], "--pattern", "SHA256SUMS", "--clobber")
    sums = {line.split()[-1].lstrip("*"): line.split()[0]
            for line in (builds / "SHA256SUMS").read_text().splitlines() if line.strip()}
    for name in names:
        if hashlib.file_digest((builds / name).open("rb"), "sha256").hexdigest() != sums.get(name):
            raise RuntimeError(f"Upstream checksum mismatch: {name}")
    run("node", "scripts/build-desktop-artifact.ts", "--platform", "mac", "--target", "zip",
        "--arch", "arm64", "--build-version", ver, "--output-dir", builds)
    app_zip = builds / f"T3-Code-{ver}-arm64.zip"
    run("ditto", "-x", "-k", app_zip, builds / "desktop")
    app = builds / "desktop/T3 Code (Beta).app"
    run("codesign", "--verify", "--deep", "--strict", app)
    signature = subprocess.check_output(["codesign", "-d", "-r-", "--verbose=2", str(app)], stderr=subprocess.STDOUT, text=True)
    if "Signature=adhoc" in signature or "Authority=Apple Development:" not in signature:
        raise RuntimeError("Persistent local Apple signing identity is required")
    original = package.read_text()
    try:
        document = json.loads(original)
        document["version"] = ver
        package.write_text(json.dumps(document, indent=2) + "\n")
        for platform in ["darwin-arm64", "linux-x64"]:
            run("node", "apps/server/scripts/cli.ts", "build-exe", "--target", platform)
            shutil.copy2(root / f"apps/server/dist-exe/t3-{platform}", builds / f"t3-{platform}")
    finally:
        package.write_text(original)
    archives = {}
    for platform, name in zip(["darwin-arm64", "linux-x64"], names):
        unpack = builds / f"upstream-{platform}"
        unpack.mkdir()
        with tarfile.open(builds / name) as tar:
            tar.extractall(unpack, filter="data")
        content = unpack / f"t3-{base_version}-{platform}"
        shutil.copy2(builds / f"t3-{platform}", content / "t3")
        shutil.rmtree(content / "client")
        shutil.copytree(root / "apps/server/dist/client", content / "client")
        (content / ".fleet-source.json").write_text(json.dumps({"version": ver, "source": output("git", "rev-parse", "HEAD"), "upstream": upstream}))
        archive = builds / f"fleet-{platform}.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            tar.add(content, arcname=f"t3-{ver}-{platform}")
        archives[platform] = archive
    helper = distribute(ver, archives)
    stage(ver, archives["darwin-arm64"])
    # Nothing is switched until all three complete the same staging checks.
    for host in ["m3", "j"]:
        remote(host, helper, "host-idle", "--version", ver)
    saved = backup(ver)
    for host in ["m3", "j"]:
        remote(host, helper, "host-activate", "--version", ver)
        remote(host, helper, "host-verify", "--version", ver)
        runner = output("node", "--input-type=module", "-e",
                        "import {buildRemoteT3RunnerScript} from './packages/ssh/src/tunnel.ts';"
                        f"process.stdout.write(buildRemoteT3RunnerScript({{archiveVersion:{json.dumps(ver)}}}));")
        result = subprocess.check_output(["ssh", ssh_route(host), "sh -s -- --version"], input=runner, text=True).strip()
        if result != f"t3 v{ver}":
            raise RuntimeError(f"{host}: desktop SSH runner version mismatch")
    idle()
    run("osascript", "-e", 'tell application "T3 Code (Beta)" to quit')
    time.sleep(2)
    installed = Path("/Applications/T3 Code (Beta).app")
    installed.rename(saved / installed.name)
    run("ditto", app, installed)
    preferences = Path.home() / ".t3/userdata/client-settings.json"
    if preferences.exists() and disable_project_folders:
        shutil.copy2(preferences, saved / preferences.name)
        settings = json.loads(preferences.read_text())
        settings.get("settings", settings).update(boringSidebarEnabled=False, legacySidebarEnabled=False)
        preferences.write_text(json.dumps(settings, indent=2) + "\n")
    launcher = Path.home() / ".local/bin/t3"
    temporary = launcher.with_name("t3.fleet-next")
    temporary.symlink_to(runtime(ver) / "t3")
    temporary.replace(launcher)
    run("open", installed)
    verify(ver)
    payload_source = json.loads((runtime(ver) / ".fleet-source.json").read_text())["source"]
    (builds / "fleet-complete.json").write_text(json.dumps({"version": ver, "hosts": ["m5", "m3", "j"], "source": payload_source, "rolloutToolSource": output("git", "rev-parse", "HEAD")}))
    print(f"Fleet complete: M5, M3 and J all run {ver}", flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", nargs="?", default="rebuild", choices=["rebuild", "host-stage", "host-idle", "host-activate", "host-verify"])
    parser.add_argument("--version", required=True, type=version)
    parser.add_argument("--upstream-tag")
    parser.add_argument("--archive")
    parser.add_argument("--disable-project-folders", action="store_true")
    args = parser.parse_args()
    try:
        if args.action == "host-stage":
            stage(args.version, args.archive)
        elif args.action == "host-idle":
            idle()
        elif args.action == "host-activate":
            activate(args.version)
        elif args.action == "host-verify":
            verify(args.version)
        elif args.upstream_tag:
            rebuild(args.version, args.upstream_tag, args.disable_project_folders)
        else:
            parser.error("--upstream-tag is required for a rebuild")
    except Exception as error:
        print(f"Fleet update INCOMPLETE: {error}", file=sys.stderr, flush=True)
        sys.exit(1)
