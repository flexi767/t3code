use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        return Err(format!("{program} failed: {status}").into());
    }
    Ok(())
}
fn output(program: &str, args: &[&str]) -> Result<String> {
    let result = Command::new(program).args(args).output()?;
    if !result.status.success() {
        return Err(format!("{program}: {}", String::from_utf8_lossy(&result.stderr)).into());
    }
    Ok(String::from_utf8(result.stdout)?.trim().to_string())
}
fn s(path: &Path) -> &str {
    path.to_str().expect("UTF-8 deployment path")
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
fn home() -> Result<PathBuf> {
    Ok(PathBuf::from(env::var("HOME")?))
}
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repository root")
}
fn valid_version(value: &str) -> bool {
    let Some((base, suffix)) = value.split_once('-') else {
        return false;
    };
    let numeric = |v: &str| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit());
    let base: Vec<_> = base.split('.').collect();
    let suffix: Vec<_> = suffix.split('.').collect();
    base.len() == 3
        && base.iter().all(|v| numeric(v))
        && suffix.len() == 3
        && matches!(suffix[0], "preview" | "nightly")
        && suffix[1].len() == 8
        && numeric(suffix[1])
        && numeric(suffix[2])
}
fn runtime(ver: &str) -> Result<PathBuf> {
    if !valid_version(ver) {
        return Err("Use an exact preview or nightly version".into());
    }
    Ok(home()?.join(".t3/runtime/versions").join(ver))
}
fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn atomic_copy(source: &Path, target: &Path) -> Result<()> {
    fs::create_dir_all(target.parent().ok_or("Missing target parent")?)?;
    let temporary = target.with_file_name(format!(".t3-next-{}", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        std::io::copy(&mut fs::File::open(source)?, &mut file)?;
        file.sync_all()?;
        if digest(source)? != digest(&temporary)? {
            return Err("Copy checksum mismatch".into());
        }
        fs::rename(&temporary, target)?;
        Ok(())
    })();
    if temporary.exists() {
        fs::remove_file(temporary)?;
    }
    result
}
fn files(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut result = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(format!("Symlink in UI build: {}", entry.path().display()).into());
        }
        if kind.is_dir() {
            result.extend(files(&entry.path())?);
        } else if kind.is_file() {
            result.push(entry.path());
        } else {
            return Err("Unsupported UI asset type".into());
        }
    }
    Ok(result)
}
fn publish(source: &Path, target: &Path) -> Result<()> {
    if !source.join("index.html").is_file() {
        return Err("UI build has no index.html".into());
    }
    let mut entries = files(source)?;
    entries.sort_by_key(|p| (p == &source.join("index.html"), p.clone()));
    for file in entries {
        atomic_copy(&file, &target.join(file.strip_prefix(source)?))?;
    }
    Ok(())
}
fn idle() -> Result<()> {
    let db = home()?.join(".t3/userdata/statev2.sqlite");
    idle_at(&db)
}
fn idle_at(db: &Path) -> Result<()> {
    if db.exists() {
        let count = output(
            "sqlite3",
            &[
                "-readonly",
                s(db),
                "SELECT count(*) FROM orchestration_v2_projection_runs WHERE status IN ('running','preparing','waiting')",
            ],
        )?;
        if count != "0" {
            return Err(
                format!("{count} active turns; finish before switching server versions").into(),
            );
        }
    }
    Ok(())
}
fn backup(ver: &str) -> Result<PathBuf> {
    idle()?;
    let dest = home()?.join(".t3/backups/fleet").join(ver);
    fs::create_dir_all(&dest)?;
    let db = home()?.join(".t3/userdata/statev2.sqlite");
    if db.exists() {
        run(
            "sqlite3",
            &[
                "-readonly",
                s(&db),
                &format!(".backup {}", quote(s(&dest.join("statev2.sqlite")))),
            ],
        )?;
    }
    Ok(dest)
}
fn stage(ver: &str, archive: &Path) -> Result<()> {
    let target = runtime(ver)?;
    stage_at(ver, archive, &target)
}
fn stage_at(ver: &str, archive: &Path, target: &Path) -> Result<()> {
    if target.exists() {
        return Err("Version already exists; use a new version".into());
    }
    let listing = output("tar", &["-tf", s(archive)])?;
    if listing.lines().any(|p| {
        Path::new(p).components().any(|c| {
            matches!(
                c,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    }) {
        return Err("Unsafe archive path".into());
    }
    fs::create_dir_all(target)?;
    run(
        "tar",
        &["-xf", s(archive), "--strip-components=1", "-C", s(target)],
    )?;
    if output(s(&target.join("t3")), &["--version"])? != format!("t3 v{ver}") {
        return Err("Staged CLI version mismatch".into());
    }
    if !target.join("client/index.html").is_file() {
        return Err("Missing client entry".into());
    }
    fs::write(target.join(".install-complete"), format!("{ver}\n"))?;
    println!("Staged {ver}");
    Ok(())
}
fn link_cli(ver: &str) -> Result<()> {
    let launcher = home()?.join(".local/bin/t3");
    let temporary = launcher.with_file_name("t3.fleet-next");
    std::os::unix::fs::symlink(runtime(ver)?.join("t3"), &temporary)?;
    fs::rename(temporary, launcher)?;
    Ok(())
}
fn activate(ver: &str) -> Result<()> {
    if fs::read_to_string(runtime(ver)?.join(".install-complete"))?.trim() != ver {
        return Err("Unverified runtime".into());
    }
    let saved = backup(ver)?;
    let mac = cfg!(target_os = "macos");
    let service = home()?.join(if mac {
        "Library/LaunchAgents/com.t3tools.t3code.service.plist"
    } else {
        ".config/systemd/user/t3code.service"
    });
    let original = fs::read_to_string(&service)?;
    let marker = "/runtime/versions/";
    if original.matches(marker).count() != 1 {
        return Err("Expected exactly one managed executable".into());
    }
    let start = original.find(marker).unwrap() + marker.len();
    let end = start
        + original[start..]
            .find('/')
            .ok_or("Invalid service executable")?;
    let mut replacement = original.clone();
    replacement.replace_range(start..end, ver);
    fs::copy(
        &service,
        saved.join(service.file_name().ok_or("Service filename")?),
    )?;
    let domain = format!("gui/{}", output("id", &["-u"])?);
    if mac {
        run("launchctl", &["bootout", &domain, s(&service)])?;
    }
    fs::write(&service, replacement)?;
    link_cli(ver)?;
    if mac {
        run("launchctl", &["bootstrap", &domain, s(&service)])?;
    } else {
        run("systemctl", &["--user", "daemon-reload"])?;
        run("systemctl", &["--user", "restart", "t3code"])?;
    }
    Ok(())
}
fn verify(ver: &str) -> Result<()> {
    if output(s(&home()?.join(".local/bin/t3")), &["--version"])? != format!("t3 v{ver}") {
        return Err("Launcher version mismatch".into());
    }
    if fs::read_to_string(runtime(ver)?.join(".install-complete"))?.trim() != ver {
        return Err("Runtime marker mismatch".into());
    }
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        if let Ok(text) = output(
            "curl",
            &[
                "-fsS",
                "--max-time",
                "4",
                "http://127.0.0.1:3773/.well-known/t3/environment",
            ],
        ) && let Ok(value) = serde_json::from_str::<Value>(&text)
            && value["serverVersion"] == ver
        {
            println!("Verified {}: {ver}", value["label"]);
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("Server did not reach requested version".into());
        }
        thread::sleep(Duration::from_secs(2));
    }
}
fn route(host: &str) -> String {
    if host == "m3" {
        env::var("T3CODE_FLEET_M3_SSH_HOST").unwrap_or_else(|_| host.into())
    } else {
        host.into()
    }
}
fn ssh(host: &str, command: &str) -> Result<String> {
    output(
        "ssh",
        &[
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=3",
            &route(host),
            command,
        ],
    )
}
fn remote(host: &str, helper: &str, args: &[&str]) -> Result<()> {
    let result = ssh(
        host,
        &std::iter::once(helper)
            .chain(args.iter().copied())
            .map(quote)
            .collect::<Vec<_>>()
            .join(" "),
    )?;
    if !result.is_empty() {
        println!("{host}: {result}");
    }
    Ok(())
}
fn seed_cache(destination: &Path, platform: &str) -> Result<()> {
    if destination.exists() {
        return Ok(());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir("/tmp")? {
        let path = entry?.path();
        if path != destination
            && path.file_name().is_some_and(|n| {
                n.to_string_lossy().starts_with("t3-fleet-")
                    && n.to_string_lossy().ends_with(&format!("-{platform}.tar"))
            })
            && path.is_file()
        {
            candidates.push((fs::metadata(&path)?.modified()?, path));
        }
    }
    candidates.sort();
    if let Some((_, previous)) = candidates.last() {
        fs::copy(previous, destination)?;
    }
    Ok(())
}
fn prepare_helpers(ver: &str) -> Result<String> {
    let directory = format!("/tmp/t3-fork-deploy-{ver}");
    ssh("j", &format!("mkdir -p {}", quote(&directory)))?;
    let source = root().join("native/fork-deploy/");
    run(
        "rsync",
        &[
            "-azc",
            "--exclude",
            "target",
            &format!("{}/", s(&source)),
            &format!("j:{directory}/"),
        ],
    )?;
    ssh(
        "m3",
        &format!(
            "rsync -azc --exclude target {} /tmp/",
            quote(&format!("j:{directory}"))
        ),
    )?;
    let helper = format!("{directory}/target/release/t3-fork-deploy");
    // Select an already installed toolchain on hosts whose rustup default is unset.
    let compile = format!(
        "set -e; for tc in \"$HOME\"/.rustup/toolchains/*; do if [ -x \"$tc/bin/cargo\" ]; then export PATH=\"$tc/bin:$PATH\"; break; fi; done; cargo build --locked --release --manifest-path {}",
        quote(&format!("{directory}/Cargo.toml"))
    );
    for host in ["j", "m3"] {
        println!("Compiling deployment helper on {host}");
        println!("{}", ssh(host, &compile)?);
    }
    Ok(helper)
}
fn distribute(ver: &str, builds: &Path) -> Result<()> {
    let helper = prepare_helpers(ver)?;
    let transport = "ssh -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3";
    for platform in ["linux-x64", "darwin-arm64"] {
        let archive = builds.join(format!("fleet-{platform}.tar"));
        let destination = format!("/tmp/t3-fleet-{ver}-{platform}.tar");
        remote(
            "j",
            &helper,
            &[
                "host-seed-cache",
                "--archive",
                &destination,
                "--platform",
                platform,
            ],
        )?;
        run(
            "rsync",
            &[
                "-azc",
                "--partial",
                "--inplace",
                "-e",
                transport,
                s(&archive),
                &format!("j:{destination}"),
            ],
        )?;
        let host = if platform == "darwin-arm64" {
            "m3"
        } else {
            "j"
        };
        if host == "m3" {
            remote(
                host,
                &helper,
                &[
                    "host-seed-cache",
                    "--archive",
                    &destination,
                    "--platform",
                    platform,
                ],
            )?;
            ssh(
                host,
                &format!(
                    "rsync -azc --partial --inplace -e {} {} /tmp/",
                    quote(transport),
                    quote(&format!("j:{destination}"))
                ),
            )?;
        }
        let remote_hash = ssh(
            host,
            &format!("{} hash --archive {}", quote(&helper), quote(&destination)),
        )?;
        if remote_hash != digest(&archive)? {
            return Err(format!("{host}: archive checksum mismatch").into());
        }
        remote(
            host,
            &helper,
            &["host-stage", "--version", ver, "--archive", &destination],
        )?;
    }
    stage(ver, &builds.join("fleet-darwin-arm64.tar"))?;
    for host in ["m3", "j"] {
        remote(host, &helper, &["host-idle"])?;
    }
    let saved = backup(ver)?;
    for host in ["m3", "j"] {
        remote(host, &helper, &["host-activate", "--version", ver])?;
        remote(host, &helper, &["host-verify", "--version", ver])?;
        let runner = output(
            "node",
            &[
                "--input-type=module",
                "-e",
                &format!(
                    "import {{buildRemoteT3RunnerScript}} from './packages/ssh/src/tunnel.ts';process.stdout.write(buildRemoteT3RunnerScript({{archiveVersion:{}}}));",
                    serde_json::to_string(ver)?
                ),
            ],
        )?;
        let mut process = Command::new("ssh")
            .args([&route(host), "sh -s -- --version"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()?;
        process
            .stdin
            .take()
            .ok_or("SSH input")?
            .write_all(runner.as_bytes())?;
        let result = process.wait_with_output()?;
        if !result.status.success()
            || String::from_utf8(result.stdout)?.trim() != format!("t3 v{ver}")
        {
            return Err(format!("{host}: SSH runner version mismatch").into());
        }
    }
    idle()?;
    run(
        "osascript",
        &["-e", "tell application \"T3 Code (Beta)\" to quit"],
    )?;
    thread::sleep(Duration::from_secs(2));
    let installed = Path::new("/Applications/T3 Code (Beta).app");
    fs::rename(installed, saved.join(installed.file_name().unwrap()))?;
    run(
        "ditto",
        &[s(&builds.join("desktop/T3 Code (Beta).app")), s(installed)],
    )?;
    link_cli(ver)?;
    run("open", &[s(installed)])?;
    verify(ver)?;
    fs::write(
        builds.join("fleet-complete.json"),
        serde_json::to_vec_pretty(
            &json!({"version":ver,"hosts":["m5","m3","j"],"source":output("git", &["rev-parse","HEAD"])?}),
        )?,
    )?;
    println!("Fleet complete: M5, M3 and J run {ver}");
    Ok(())
}

struct RestoreFile {
    path: PathBuf,
    original: String,
}
impl Drop for RestoreFile {
    fn drop(&mut self) {
        if let Err(error) = fs::write(&self.path, &self.original) {
            eprintln!("Cannot restore {}: {error}", self.path.display());
        }
    }
}
fn fleet(ver: &str, upstream: &str) -> Result<()> {
    runtime(ver)?;
    env::set_current_dir(root())?;
    if !output(
        "git",
        &["status", "--porcelain", "--untracked-files=normal"],
    )?
    .is_empty()
    {
        return Err("Commit source changes before rebuilding".into());
    }
    run("git", &["merge-base", "--is-ancestor", upstream, "HEAD"])?;
    run(
        "git",
        &[
            "diff",
            "--exit-code",
            upstream,
            "--",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
        ],
    )?;
    let package = root().join("apps/server/package.json");
    let original = fs::read_to_string(&package)?;
    let base: Value = serde_json::from_str(&output(
        "git",
        &["show", &format!("{upstream}:apps/server/package.json")],
    )?)?;
    let mut document: Value = serde_json::from_str(&original)?;
    if base["dependencies"] != document["dependencies"] {
        return Err("Server dependencies differ from upstream runtime".into());
    }
    idle()?;
    for host in ["m3", "j"] {
        ssh(host, "true")?;
    }
    ssh("m3", "ssh -o BatchMode=yes -o ConnectTimeout=8 j true")?;
    let builds = home()?.join(".t3/builds").join(ver);
    fs::create_dir(&builds)?;
    let base_version = upstream.strip_prefix('v').unwrap_or(upstream);
    let names = [
        format!("t3-{base_version}-darwin-arm64.tar.gz"),
        format!("t3-{base_version}-linux-x64.tar.gz"),
    ];
    run(
        "gh",
        &[
            "release",
            "download",
            upstream,
            "--repo",
            "pingdotgg/t3code",
            "--dir",
            s(&builds),
            "--pattern",
            &names[0],
            "--pattern",
            &names[1],
            "--pattern",
            "SHA256SUMS",
        ],
    )?;
    let sums = fs::read_to_string(builds.join("SHA256SUMS"))?;
    for name in &names {
        let expected = sums.lines().find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let file = parts.next()?.trim_start_matches('*');
            (file == name).then_some(hash)
        });
        if expected != Some(digest(&builds.join(name))?.as_str()) {
            return Err(format!("Upstream checksum mismatch: {name}").into());
        }
    }
    run(
        "node",
        &[
            "scripts/build-desktop-artifact.ts",
            "--platform",
            "mac",
            "--target",
            "zip",
            "--arch",
            "arm64",
            "--build-version",
            ver,
            "--output-dir",
            s(&builds),
        ],
    )?;
    run(
        "ditto",
        &[
            "-x",
            "-k",
            s(&builds.join(format!("T3-Code-{ver}-arm64.zip"))),
            s(&builds.join("desktop")),
        ],
    )?;
    let app = builds.join("desktop/T3 Code (Beta).app");
    run("codesign", &["--verify", "--deep", "--strict", s(&app)])?;
    let signature = Command::new("codesign")
        .args(["-d", "-r-", "--verbose=2", s(&app)])
        .output()?;
    let signature_text = String::from_utf8_lossy(&signature.stderr);
    if !signature.status.success()
        || signature_text.contains("Signature=adhoc")
        || !signature_text.contains("Authority=Apple Development:")
    {
        return Err("Persistent Apple signing identity required".into());
    }
    {
        let restore = RestoreFile {
            path: package.clone(),
            original,
        };
        document["version"] = ver.into();
        fs::write(
            &package,
            format!("{}\n", serde_json::to_string_pretty(&document)?),
        )?;
        for platform in ["darwin-arm64", "linux-x64"] {
            run(
                "node",
                &[
                    "apps/server/scripts/cli.ts",
                    "build-exe",
                    "--target",
                    platform,
                ],
            )?;
            fs::copy(
                root().join(format!("apps/server/dist-exe/t3-{platform}")),
                builds.join(format!("t3-{platform}")),
            )?;
        }
        fs::write(&package, &restore.original)?;
        drop(restore);
    }
    for (platform, name) in ["darwin-arm64", "linux-x64"].iter().zip(names) {
        let unpack = builds.join(format!("upstream-{platform}"));
        fs::create_dir(&unpack)?;
        run("tar", &["-xf", s(&builds.join(name)), "-C", s(&unpack)])?;
        let content = unpack.join(format!("t3-{base_version}-{platform}"));
        fs::copy(builds.join(format!("t3-{platform}")), content.join("t3"))?;
        let client = content.join("client");
        if client.is_symlink() || !client.starts_with(&builds) {
            return Err("Unsafe client replacement path".into());
        }
        fs::remove_dir_all(&client)?;
        run(
            "rsync",
            &[
                "-a",
                s(&root().join("apps/server/dist/client")),
                s(&content),
            ],
        )?;
        fs::write(
            content.join(".fleet-source.json"),
            serde_json::to_vec(
                &json!({"version":ver,"source":output("git", &["rev-parse","HEAD"])?,"upstream":upstream}),
            )?,
        )?;
        let staging_name = format!("t3-{ver}-{platform}");
        let staging = unpack.join(&staging_name);
        fs::rename(content, &staging)?;
        run(
            "tar",
            &[
                "-cf",
                s(&builds.join(format!("fleet-{platform}.tar"))),
                "-C",
                s(&unpack),
                &staging_name,
            ],
        )?;
    }
    distribute(ver, &builds)
}

fn ui(args: &BTreeMap<String, String>) -> Result<()> {
    env::set_current_dir(root())?;
    let app = PathBuf::from(
        args.get("app")
            .map(String::as_str)
            .unwrap_or("/Applications/T3 Code (Beta).app"),
    );
    let base = args
        .get("base-dir")
        .map(PathBuf::from)
        .unwrap_or(home()?.join(".t3"));
    let info = plist::Value::from_file(app.join("Contents/Info.plist"))?;
    let ver = info
        .as_dictionary()
        .and_then(|d| d.get("CFBundleShortVersionString"))
        .and_then(plist::Value::as_string)
        .ok_or("Missing desktop version")?;
    if !fs::read(app.join("Contents/Resources/app.asar"))?
        .windows(b"uiClientDirectory".len())
        .any(|w| w == b"uiClientDirectory")
    {
        return Err("Desktop needs one-time UI-loader bootstrap".into());
    }
    let baseline: Value = serde_json::from_slice(&fs::read(
        base.join("runtime/versions")
            .join(ver)
            .join(".fleet-source.json"),
    )?)?;
    let changed = output(
        "git",
        &[
            "diff",
            "--name-only",
            baseline["source"]
                .as_str()
                .ok_or("Missing baseline source")?,
            "HEAD",
        ],
    )?;
    let allowed = [
        "apps/web/src/",
        "apps/web/public/",
        "apps/desktop/src/",
        "scripts/",
        "docs/",
        "native/fork-deploy/",
    ];
    if let Some(unsafe_path) = changed
        .lines()
        .find(|p| *p != "AGENTS.md" && !allowed.iter().any(|prefix| p.starts_with(prefix)))
    {
        return Err(format!(
            "Backend/contract/dependency changes require full update: {unsafe_path}"
        )
        .into());
    }
    if !output("git", &["status", "--porcelain"])?.is_empty() {
        return Err("Commit source changes before publishing UI".into());
    }
    let source = if let Some(source) = args.get("built-client") {
        PathBuf::from(source)
    } else {
        run("vp", &["run", "--filter", "@t3tools/web", "build"])?;
        run(
            "node",
            &[
                "scripts/apply-web-brand-assets.ts",
                "production",
                "apps/web/dist",
            ],
        )?;
        root().join("apps/web/dist")
    };
    let target = base.join("ui").join(ver).join("client");
    if target.join("index.html").exists() {
        atomic_copy(
            &target.join("index.html"),
            &target
                .parent()
                .unwrap()
                .join("backups")
                .join(format!("{}.html", digest(&target.join("index.html"))?)),
        )?;
    }
    publish(&source, &target)?;
    let revision = output("git", &["rev-parse", "HEAD"])?;
    fs::write(
        target.parent().unwrap().join("revision.json"),
        serde_json::to_vec(&json!({"source":revision,"serverVersion":ver}))?,
    )?;
    println!(
        "UI updated to {}; CLI/server remains {ver}. Reload the window.",
        &revision[..10]
    );
    Ok(())
}
fn parse() -> Result<(String, BTreeMap<String, String>)> {
    let mut values = env::args().skip(1);
    let action = values.next().unwrap_or_else(|| "help".into());
    let mut flags = BTreeMap::new();
    while let Some(key) = values.next() {
        if !key.starts_with("--") {
            return Err(format!("Expected flag, got {key}").into());
        }
        let key = key.trim_start_matches("--").to_string();
        if ![
            "version",
            "upstream-tag",
            "archive",
            "platform",
            "app",
            "base-dir",
            "built-client",
        ]
        .contains(&key.as_str())
        {
            return Err(format!("Unknown flag: {key}").into());
        }
        if flags
            .insert(key, values.next().ok_or("Flag needs a value")?)
            .is_some()
        {
            return Err("Duplicate flag".into());
        }
    }
    Ok((action, flags))
}
fn main() {
    let result = (|| -> Result<()> {
        let (action, flags) = parse()?;
        let get = |name: &str| -> Result<&str> {
            flags
                .get(name)
                .map(String::as_str)
                .ok_or_else(|| format!("--{name} required").into())
        };
        match action.as_str() {
            "ui" => ui(&flags),
            "fleet" => fleet(get("version")?, get("upstream-tag")?),
            "host-stage" => stage(get("version")?, Path::new(get("archive")?)),
            "host-idle" => idle(),
            "host-activate" => activate(get("version")?),
            "host-verify" => verify(get("version")?),
            "host-seed-cache" => seed_cache(Path::new(get("archive")?), get("platform")?),
            "hash" => {
                println!("{}", digest(Path::new(get("archive")?))?);
                Ok(())
            }
            "help" | "--help" => {
                println!(
                    "fork-deploy ui [--app PATH] [--base-dir PATH] [--built-client PATH]\nfork-deploy fleet --version VERSION --upstream-tag TAG\nFull fleet updates require idle hosts; UI updates never restart servers."
                );
                Ok(())
            }
            _ => Err(format!("Unknown action: {action}").into()),
        }
    })();
    if let Err(error) = result {
        eprintln!("Update incomplete: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temporary(name: &str) -> PathBuf {
        let path = env::temp_dir().join(format!("t3-rust-deploy-{}-{name}", std::process::id()));
        fs::create_dir(&path).unwrap();
        path
    }
    #[test]
    fn rejects_unsafe_versions() {
        for value in [
            "latest",
            "../other",
            "1.2.3",
            "1.2.3-preview.20261104.1/other",
            "1.2.3-preview.x.1",
        ] {
            assert!(!valid_version(value));
        }
        assert!(valid_version("1.2.3-preview.20261104.1"));
    }
    #[test]
    fn staging_wrong_binary_never_marks_install_complete() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temporary("stage");
        let source = dir.join("content");
        fs::create_dir_all(source.join("client")).unwrap();
        fs::write(source.join("client/index.html"), "web").unwrap();
        fs::write(source.join("t3"), "#!/bin/sh\necho 't3 v0.0.1'\n").unwrap();
        fs::set_permissions(source.join("t3"), fs::Permissions::from_mode(0o755)).unwrap();
        let archive = dir.join("runtime.tar");
        run("tar", &["-cf", s(&archive), "-C", s(&dir), "content"]).unwrap();
        let target = dir.join("runtime");
        let old = dir.join("previous");
        fs::write(&old, "keep").unwrap();
        assert!(stage_at("1.2.3-preview.20261104.1", &archive, &target).is_err());
        assert!(!target.join(".install-complete").exists());
        assert_eq!(fs::read_to_string(&old).unwrap(), "keep");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn idle_guard_reads_database_and_refuses_active_turns() {
        let dir = temporary("idle");
        let db = dir.join("state.sqlite");
        run("sqlite3", &[s(&db), "CREATE TABLE orchestration_v2_projection_runs(status TEXT); INSERT INTO orchestration_v2_projection_runs VALUES ('completed');"]).unwrap();
        idle_at(&db).unwrap();
        run(
            "sqlite3",
            &[
                s(&db),
                "INSERT INTO orchestration_v2_projection_runs VALUES ('running');",
            ],
        )
        .unwrap();
        assert!(idle_at(&db).is_err());
        assert_eq!(
            output(
                "sqlite3",
                &[
                    "-readonly",
                    s(&db),
                    "SELECT count(*) FROM orchestration_v2_projection_runs"
                ]
            )
            .unwrap(),
            "2"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn package_version_restores_when_build_aborts() {
        let dir = temporary("restore");
        let package = dir.join("package.json");
        fs::write(&package, "original").unwrap();
        {
            let _restore = RestoreFile {
                path: package.clone(),
                original: "original".into(),
            };
            fs::write(&package, "temporary version").unwrap();
        }
        assert_eq!(fs::read_to_string(package).unwrap(), "original");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn publishes_entry_and_retains_old_chunks() {
        let dir = temporary("publish");
        let source = dir.join("source");
        let target = dir.join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("old.js"), "old").unwrap();
        fs::write(source.join("new.js"), "new").unwrap();
        fs::write(source.join("index.html"), "updated").unwrap();
        publish(&source, &target).unwrap();
        assert_eq!(fs::read_to_string(target.join("old.js")).unwrap(), "old");
        assert_eq!(fs::read_to_string(target.join("new.js")).unwrap(), "new");
        assert_eq!(
            fs::read_to_string(target.join("index.html")).unwrap(),
            "updated"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn invalid_build_keeps_entry() {
        let dir = temporary("invalid");
        let source = dir.join("source");
        let target = dir.join("target");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&target).unwrap();
        fs::write(target.join("index.html"), "current").unwrap();
        assert!(publish(&source, &target).is_err());
        fs::write(source.join("index.html"), "new").unwrap();
        std::os::unix::fs::symlink(target.join("index.html"), source.join("link.js")).unwrap();
        assert!(publish(&source, &target).is_err());
        assert_eq!(
            fs::read_to_string(target.join("index.html")).unwrap(),
            "current"
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
