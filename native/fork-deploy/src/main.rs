mod drain;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fs,
    io::{Read, Write},
    os::unix::process::CommandExt,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

const CONNECT_KEYS: [&str; 3] = [
    "T3CODE_RELAY_URL",
    "T3CODE_CLERK_PUBLISHABLE_KEY",
    "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
];

const CONNECT_JWT_TEMPLATE_KEY: &str = "T3CODE_CLERK_JWT_TEMPLATE";

fn validate_connect_environment(values: &BTreeMap<String, String>) -> Result<()> {
    if CONNECT_KEYS
        .iter()
        .any(|key| values.get(*key).is_none_or(|v| v.trim().is_empty()))
        || !values
            .get(CONNECT_KEYS[0])
            .is_some_and(|v| v.starts_with("https://"))
        || !values
            .get(CONNECT_KEYS[1])
            .is_some_and(|v| v.starts_with("pk_"))
    {
        return Err("Full builds require all three T3 Connect public settings; set them in the environment or ~/.t3/fork-connect-public.json".into());
    }
    Ok(())
}

fn connect_build_environment() -> Result<BTreeMap<String, String>> {
    let path = home()?.join(".t3/fork-connect-public.json");
    let stored: BTreeMap<String, String> = if path.exists() {
        serde_json::from_slice(&fs::read(path)?)?
    } else {
        BTreeMap::new()
    };
    let lookup = |key: &str| {
        env::var(key)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| stored.get(key).cloned())
    };
    let mut values: BTreeMap<String, String> = CONNECT_KEYS
        .into_iter()
        .map(|key| (key.to_owned(), lookup(key).unwrap_or_default()))
        .collect();
    validate_connect_environment(&values)?;
    // The hosted web client needs this too, but a repo .env can supply it to the build instead.
    match lookup(CONNECT_JWT_TEMPLATE_KEY) {
        Some(template) => {
            values.insert(CONNECT_JWT_TEMPLATE_KEY.to_owned(), template);
        }
        None => eprintln!(
            "Warning: {CONNECT_JWT_TEMPLATE_KEY} is not set here; web clients lose T3 Connect unless .env provides it."
        ),
    }
    Ok(values)
}

fn build_with_connect(args: &[&str], values: &BTreeMap<String, String>) -> Result<()> {
    let status = Command::new("node").args(args).envs(values).status()?;
    if !status.success() {
        return Err(format!("Connect-enabled build failed: {status}").into());
    }
    Ok(())
}

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
const DESKTOP_APP: &str = "T3 Code (Beta)";
const SERVICE_LABEL: &str = "com.t3tools.t3code.service";

/// How activation treats running turns. Neither set: refuse unless already idle.
#[derive(Clone, Copy, Default)]
struct Activation {
    idle_timeout: Option<u64>,
    force: bool,
}
fn state_db() -> Result<PathBuf> {
    Ok(home()?.join(".t3/userdata/statev2.sqlite"))
}
fn read_idle_count(mut read: impl FnMut() -> Result<String>) -> Result<String> {
    for attempt in 0..10 {
        match read() {
            Ok(count) => return Ok(count),
            Err(error) => {
                if attempt == 9
                    || !error
                        .to_string()
                        .contains("unable to open database file (14)")
                {
                    return Err(error);
                }
                thread::sleep(Duration::from_millis(200));
            }
        }
    }
    unreachable!()
}
// A read-only connection cannot create the -shm a WAL database needs, so it fails with
// error 14 once the app has closed cleanly. With no sidecars the main file is complete.
fn sqlite_has_writer(db: &Path) -> bool {
    let path = db.display().to_string();
    ["-wal", "-shm", "-journal"]
        .iter()
        .any(|suffix| Path::new(&format!("{path}{suffix}")).exists())
}
fn sqlite_read_args(db: &Path) -> [String; 2] {
    let path = db.display().to_string();
    if sqlite_has_writer(db) {
        ["-readonly".into(), path]
    } else {
        let uri = path
            .replace('%', "%25")
            .replace('?', "%3f")
            .replace('#', "%23");
        ["-batch".into(), format!("file:{uri}?immutable=1")]
    }
}
/// A queued run counts unless it is held or archived: a hold refuses new sends but queued work still
/// starts, while a queue blocked by a usage limit would otherwise never let the host go idle.
fn active_runs(db: &Path) -> Result<Vec<Value>> {
    if !db.exists() {
        return Ok(Vec::new());
    }
    let open = sqlite_read_args(db);
    let query = "SELECT r.thread_id AS threadId, t.title AS title, r.status AS status, \
         json_extract(t.payload_json, '$.lineage.parentThreadId') AS parentThreadId \
         FROM orchestration_v2_projection_runs AS r \
         LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = r.thread_id \
         WHERE r.status IN ('preparing','starting','running','waiting') \
         OR (r.status = 'queued' AND json_extract(r.payload_json, '$.queueHeld') IS NOT 1 \
         AND t.archived_at IS NULL AND t.deleted_at IS NULL)";
    let text = read_idle_count(|| {
        output(
            "sqlite3",
            &["-json", open[0].as_str(), open[1].as_str(), query],
        )
    })
    .map_err(|error| format!("Cannot check active turns in {}: {error}", db.display()))?;
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let runs: Vec<Value> = serde_json::from_str(&text)?;
    let held = held_threads(db);
    Ok(runs
        .into_iter()
        .filter(|run| {
            [&run["threadId"], &run["parentThreadId"]].iter().all(|id| {
                !id.as_str()
                    .is_some_and(|id| held.iter().any(|thread| thread == id))
            })
        })
        .collect())
}
/// Threads whose agents run in a live holder keep running through a restart, so they aren't busy.
fn held_threads(db: &Path) -> Vec<String> {
    let Ok(entries) = db.with_file_name("agent-holders").read_dir() else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| serde_json::from_slice::<Value>(&fs::read(entry.path()).ok()?).ok())
        .filter(|holder| {
            holder["pid"].as_u64().is_some_and(|pid| {
                Command::new("kill")
                    .args(["-0", &pid.to_string()])
                    .stderr(Stdio::null())
                    .status()
                    .is_ok_and(|status| status.success())
            })
        })
        .flat_map(|holder| {
            holder["threadIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect::<Vec<_>>()
        })
        .collect()
}
fn active_turns_at(db: &Path) -> Result<u64> {
    Ok(active_runs(db)?.len() as u64)
}
fn idle_at(db: &Path) -> Result<()> {
    let count = active_turns_at(db)?;
    if count != 0 {
        return Err(format!(
            "{count} active turns; finish before switching server versions, or use --when-idle-timeout"
        )
        .into());
    }
    Ok(())
}
fn idle() -> Result<()> {
    idle_at(&state_db()?)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}
fn backup_at(db: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    let saved = dest.join("statev2.sqlite");
    // A retry runs after migrations, so only the first snapshot can restore the old version.
    if db.exists() && !saved.exists() {
        let partial = dest.join("statev2.sqlite.partial");
        let open = sqlite_read_args(db);
        run(
            "sqlite3",
            &[
                open[0].as_str(),
                open[1].as_str(),
                &format!(".backup {}", quote(s(&partial))),
            ],
        )?;
        fs::rename(partial, saved)?;
    }
    Ok(())
}
fn desktop_swap_needed(installed: Option<&str>, ver: &str, backup_exists: bool) -> Result<bool> {
    if installed == Some(ver) {
        return Ok(false);
    }
    if backup_exists {
        return Err("A previous desktop app is already backed up for this version; inspect it before retrying".into());
    }
    Ok(true)
}
fn installed_version(app: &Path) -> Option<String> {
    output(
        "/usr/libexec/PlistBuddy",
        &[
            "-c",
            "Print CFBundleShortVersionString",
            s(&app.join("Contents/Info.plist")),
        ],
    )
    .ok()
}
fn restore_database(db: &Path, backup: &Path) -> Result<()> {
    let saved = backup.join("statev2.sqlite");
    if !saved.exists() {
        return Ok(());
    }
    // A leftover WAL from the failed version would replay onto the restored main file.
    for suffix in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{suffix}", db.display()));
        if side.exists() {
            fs::remove_file(side)?;
        }
    }
    // Moved, not copied: the old version keeps writing, so a later retry needs a fresh snapshot.
    fs::rename(saved, db)?;
    Ok(())
}
fn backup_dir(ver: &str) -> Result<PathBuf> {
    Ok(home()?.join(".t3/backups/fleet").join(ver))
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
fn link_at(launcher: &Path, target: &Path) -> Result<()> {
    let temporary = launcher.with_file_name("t3.fleet-next");
    let _ = fs::remove_file(&temporary);
    std::os::unix::fs::symlink(target, &temporary)?;
    fs::rename(temporary, launcher)?;
    Ok(())
}
fn link_cli(ver: &str) -> Result<()> {
    link_at(&home()?.join(".local/bin/t3"), &runtime(ver)?.join("t3"))
}
fn service_path() -> Result<PathBuf> {
    Ok(home()?.join(if cfg!(target_os = "macos") {
        "Library/LaunchAgents/com.t3tools.t3code.service.plist"
    } else {
        ".config/systemd/user/t3code.service"
    }))
}
fn service_with_version(original: &str, ver: &str) -> Result<(String, String)> {
    let marker = "/runtime/versions/";
    if original.matches(marker).count() != 1 {
        return Err("Expected exactly one managed executable".into());
    }
    let start = original.find(marker).unwrap() + marker.len();
    let end = start
        + original[start..]
            .find('/')
            .ok_or("Invalid service executable")?;
    let mut replacement = original.to_owned();
    replacement.replace_range(start..end, ver);
    Ok((replacement, original[start..end].to_owned()))
}
trait ServiceControl {
    fn stop(&self) -> Result<()>;
    fn start(&self) -> Result<()>;
    fn verify(&self, ver: &str) -> Result<()>;
}
struct InstalledService;
impl ServiceControl for InstalledService {
    fn stop(&self) -> Result<()> {
        if cfg!(target_os = "macos") {
            let domain = format!("gui/{}", output("id", &["-u"])?);
            // Bootout fails on a service that isn't loaded, as after an interrupted activation.
            if output(
                "launchctl",
                &["print", &format!("{domain}/{SERVICE_LABEL}")],
            )
            .is_ok()
            {
                run("launchctl", &["bootout", &domain, s(&service_path()?)])?;
            }
            Ok(())
        } else {
            run("systemctl", &["--user", "stop", "t3code"])
        }
    }
    fn start(&self) -> Result<()> {
        if cfg!(target_os = "macos") {
            let domain = format!("gui/{}", output("id", &["-u"])?);
            if output(
                "launchctl",
                &["print", &format!("{domain}/{SERVICE_LABEL}")],
            )
            .is_ok()
            {
                return Ok(());
            }
            run("launchctl", &["bootstrap", &domain, s(&service_path()?)])
        } else {
            run("systemctl", &["--user", "daemon-reload"])?;
            run("systemctl", &["--user", "start", "t3code"])
        }
    }
    fn verify(&self, ver: &str) -> Result<()> {
        verify(ver)
    }
}
struct SwitchPaths {
    service: PathBuf,
    db: PathBuf,
    backup: PathBuf,
    launcher: PathBuf,
    runtime: PathBuf,
}
/// Stops first so the backup can't miss what graceful shutdown records for restart continuation.
/// A version that never comes up gets the previous service, launcher and database back.
fn switch_service(ver: &str, paths: &SwitchPaths, control: &impl ServiceControl) -> Result<()> {
    let original = fs::read_to_string(&paths.service)?;
    let (replacement, previous) = service_with_version(&original, ver)?;
    let previous_link = fs::read_link(&paths.launcher).ok();
    // A helper that died mid-switch leaves the new definition behind with nothing running.
    if previous == ver {
        link_at(&paths.launcher, &paths.runtime.join("t3"))?;
        control.start()?;
        return control.verify(ver);
    }
    control.stop()?;
    backup_at(&paths.db, &paths.backup)?;
    fs::copy(
        &paths.service,
        paths
            .backup
            .join(paths.service.file_name().ok_or("Service filename")?),
    )?;
    fs::write(&paths.service, replacement)?;
    link_at(&paths.launcher, &paths.runtime.join("t3"))?;
    let failure = match control.start().and_then(|()| control.verify(ver)) {
        Ok(()) => return Ok(()),
        Err(error) => error,
    };
    let _ = control.stop();
    restore_database(&paths.db, &paths.backup)?;
    fs::write(&paths.service, original)?;
    if let Some(link) = previous_link {
        link_at(&paths.launcher, &link)?;
    }
    control.start()?;
    control.verify(&previous)?;
    Err(format!("{ver} failed ({failure}); rolled back to {previous}").into())
}
fn service_on(ver: &str) -> Result<bool> {
    let (_, current) = service_with_version(&fs::read_to_string(service_path()?)?, ver)?;
    Ok(current == ver)
}
fn activate(ver: &str, force: bool) -> Result<()> {
    if fs::read_to_string(runtime(ver)?.join(".install-complete"))?.trim() != ver {
        return Err("Unverified runtime".into());
    }
    if !force && !service_on(ver)? {
        idle()?;
    }
    switch_service(
        ver,
        &SwitchPaths {
            service: service_path()?,
            db: state_db()?,
            backup: backup_dir(ver)?,
            launcher: home()?.join(".local/bin/t3"),
            runtime: runtime(ver)?,
        },
        &InstalledService,
    )
}
fn verify(ver: &str) -> Result<()> {
    if output(s(&home()?.join(".local/bin/t3")), &["--version"])? != format!("t3 v{ver}") {
        return Err("Launcher version mismatch".into());
    }
    if fs::read_to_string(runtime(ver)?.join(".install-complete"))?.trim() != ver {
        return Err("Runtime marker mismatch".into());
    }
    // Long enough for migrations, which run before the server listens.
    let deadline = Instant::now() + Duration::from_secs(300);
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
// An unreachable M3 can be left behind; its next rollout must use a new version.
fn remote_hosts() -> &'static [&'static str] {
    if env::var_os("T3CODE_FLEET_SKIP_M3").is_some() {
        &["j"]
    } else {
        &["m3", "j"]
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
const SSH_TRANSPORT: &str =
    "ssh -o ConnectTimeout=8 -o ServerAliveInterval=10 -o ServerAliveCountMax=3";
fn prepare_helpers(ver: &str) -> Result<String> {
    let directory = format!("/tmp/t3-fork-deploy-{ver}");
    ssh("j", &format!("mkdir -p {}", quote(&directory)))?;
    let source = root().join("native/fork-deploy/");
    run(
        "rsync",
        &[
            "-azc",
            "-e",
            SSH_TRANSPORT,
            "--exclude",
            "target",
            &format!("{}/", s(&source)),
            &format!("j:{directory}/"),
        ],
    )?;
    if remote_hosts().contains(&"m3") {
        ssh(
            "m3",
            &format!(
                "rsync -azc --exclude target {} /tmp/",
                quote(&format!("j:{directory}"))
            ),
        )?;
    }
    let helper = format!("{directory}/target/release/t3-fork-deploy");
    // Select an already installed toolchain on hosts whose rustup default is unset.
    let compile = format!(
        "set -e; for tc in \"$HOME\"/.rustup/toolchains/*; do if [ -x \"$tc/bin/cargo\" ]; then export PATH=\"$tc/bin:$PATH\"; break; fi; done; cargo build --locked --release --manifest-path {}",
        quote(&format!("{directory}/Cargo.toml"))
    );
    for host in remote_hosts() {
        println!("Compiling deployment helper on {host}");
        println!("{}", ssh(host, &compile)?);
    }
    Ok(helper)
}
fn distribute(ver: &str, builds: &Path, stage_only: bool, activation: Activation) -> Result<()> {
    let helper = prepare_helpers(ver)?;
    let transport = SSH_TRANSPORT;
    for platform in ["linux-x64", "darwin-arm64"] {
        if platform == "darwin-arm64" && !remote_hosts().contains(&"m3") {
            continue;
        }
        let archive = builds.join(format!("fleet-{platform}.tar"));
        let destination = format!("/tmp/t3-fleet-{ver}-{platform}.tar");
        run(
            "rsync",
            &[
                "-azc",
                "--whole-file",
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
            ssh(
                host,
                &format!(
                    "rsync -azc --whole-file --partial --inplace -e {} {} /tmp/",
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
    // J's /tmp is RAM-backed; a staged runtime no longer needs its archive.
    for host in remote_hosts() {
        ssh(host, "rm -f /tmp/t3-fleet-*")?;
    }
    if stage_only {
        println!("Fleet {ver} staged; no running server or desktop was changed.");
        return Ok(());
    }
    activate_with(ver, builds, &helper, activation)
}

fn fleet_active_runs(helper: &str) -> Result<Vec<Value>> {
    let mut active = Vec::new();
    let mut collect = |host: &str, runs: Vec<Value>| {
        active.extend(runs.into_iter().map(|mut run| {
            run["host"] = host.into();
            run
        }));
    };
    collect("m5", active_runs(&state_db()?)?);
    for host in remote_hosts() {
        let text = ssh(host, &format!("{} host-active", quote(helper)))?;
        collect(host, serde_json::from_str(&text)?);
    }
    Ok(active)
}
fn describe_runs(runs: &[Value]) -> String {
    runs.iter()
        .map(|run| {
            format!(
                "  {} {} [{}] {}",
                run["host"].as_str().unwrap_or("?"),
                run["threadId"].as_str().unwrap_or("?"),
                run["status"].as_str().unwrap_or("?"),
                run["title"].as_str().unwrap_or(""),
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn desktop_running() -> Result<bool> {
    Ok(output(
        "osascript",
        &["-e", &format!("application \"{DESKTOP_APP}\" is running")],
    )? == "true")
}
fn quit_desktop() -> Result<()> {
    run(
        "osascript",
        &["-e", &format!("tell application \"{DESKTOP_APP}\" to quit")],
    )?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while desktop_running()? {
        if Instant::now() >= deadline {
            return Err(format!(
                "{DESKTOP_APP} did not quit; close any open dialog and retry. Nothing changed on M5."
            )
            .into());
        }
        thread::sleep(Duration::from_secs(1));
    }
    Ok(())
}
/// Moves the old app aside rather than deleting it, so a failed install can put it back.
fn replace_desktop(built: &Path, aside: &Path) -> Result<()> {
    let installed = PathBuf::from(format!("/Applications/{DESKTOP_APP}.app"));
    fs::create_dir_all(aside.parent().ok_or("Backup directory")?)?;
    fs::rename(&installed, aside)?;
    if let Err(error) = run("ditto", &[s(built), s(&installed)]) {
        let _ = fs::remove_dir_all(&installed);
        fs::rename(aside, &installed)?;
        run("open", &[s(&installed)])?;
        return Err(error);
    }
    Ok(())
}
fn activate_local(ver: &str, builds: &Path, force: bool) -> Result<()> {
    let built = builds.join(format!("desktop/{DESKTOP_APP}.app"));
    let installed = PathBuf::from(format!("/Applications/{DESKTOP_APP}.app"));
    let saved = backup_dir(ver)?;
    let aside = saved.join(format!("{DESKTOP_APP}.app"));
    let launcher = home()?.join(".local/bin/t3");
    // Decided before quitting: an app that cannot be replaced must keep running.
    if !desktop_swap_needed(
        installed_version(&installed).as_deref(),
        ver,
        aside.exists(),
    )? {
        return link_cli(ver).and_then(|()| verify(ver));
    }
    if !force {
        idle()?;
    }
    let db = state_db()?;
    quit_desktop()?;
    backup_at(&db, &saved)?;
    replace_desktop(&built, &aside)?;
    let previous_link = fs::read_link(&launcher).ok();
    link_cli(ver)?;
    run("open", &[s(&installed)])?;
    let Err(failure) = verify(ver) else {
        return Ok(());
    };
    quit_desktop()?;
    fs::remove_dir_all(&installed)?;
    fs::rename(&aside, &installed)?;
    restore_database(&db, &saved)?;
    if let Some(link) = previous_link {
        link_at(&launcher, &link)?;
    }
    run("open", &[s(&installed)])?;
    Err(format!("M5 failed ({failure}); restored the previous app and database").into())
}
fn activate_fleet(ver: &str, builds: &Path, helper: &str, force: bool) -> Result<()> {
    env::set_current_dir(root())?;
    if fs::read_to_string(runtime(ver)?.join(".install-complete"))?.trim() != ver {
        return Err("Local staged runtime is incomplete".into());
    }
    let app = builds.join(format!("desktop/{DESKTOP_APP}.app"));
    run("codesign", &["--verify", "--deep", "--strict", s(&app)])?;
    let interrupted = if force {
        let runs = fleet_active_runs(helper)?;
        if !runs.is_empty() {
            println!(
                "Forcing the restart. These threads are interrupted and resume automatically where \
                 supported. A resumed agent may re-run a command that had only partly finished, \
                 such as a migration or a push; check them. A [waiting] thread needs you first.\n{}",
                describe_runs(&runs)
            );
        }
        runs
    } else {
        if installed_version(Path::new(&format!("/Applications/{DESKTOP_APP}.app"))).as_deref()
            != Some(ver)
        {
            idle()?;
        }
        for host in remote_hosts() {
            remote(host, helper, &["host-idle", "--version", ver])?;
        }
        Vec::new()
    };
    for host in remote_hosts() {
        let mut arguments = vec!["host-activate", "--version", ver];
        if force {
            arguments.push("--force");
        }
        remote(host, helper, &arguments)?;
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
            return Err(format!(
                "{host}: SSH runner version mismatch; earlier hosts already run {ver}"
            )
            .into());
        }
    }
    activate_local(ver, builds, force)?;
    link_cli(ver)?;
    verify(ver)?;
    let source: Value =
        serde_json::from_slice(&fs::read(runtime(ver)?.join(".fleet-source.json"))?)?;
    fs::write(
        builds.join("fleet-complete.json"),
        serde_json::to_vec_pretty(&json!({
            "version": ver,
            "hosts": std::iter::once(&"m5").chain(remote_hosts()).collect::<Vec<_>>(),
            "source": source["source"],
            "forced": force,
            "interrupted": interrupted,
        }))?,
    )?;
    println!(
        "Fleet complete: M5 and {} run {ver}",
        remote_hosts().join(", ")
    );
    Ok(())
}
/// A T3 turn's process dies with the restart it requested, and that turn alone keeps the fleet
/// busy. Leaving the process group and parent frees it from both once the turn ends.
fn detach(ver: &str) -> Result<()> {
    let log_path = home()?.join(format!(".t3/logs/fleet-{ver}.log"));
    fs::create_dir_all(log_path.parent().ok_or("Log directory")?)?;
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let child = Command::new(env::current_exe()?)
        .args(
            env::args()
                .skip(1)
                .filter(|argument| argument != "--detach"),
        )
        .env_remove("T3CODE_THREAD_ID")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    println!(
        "Activating in the background as pid {}; log: {}\nEnd this turn so the fleet can go idle.",
        child.id(),
        log_path.display()
    );
    Ok(())
}
fn parse_activation(flags: &BTreeMap<String, String>) -> Result<Activation> {
    let idle_timeout = flags
        .get("when-idle-timeout")
        .map(|seconds| seconds.parse::<u64>())
        .transpose()
        .map_err(|_| "--when-idle-timeout takes seconds")?;
    if idle_timeout.is_some_and(|seconds| seconds == 0 || seconds > drain::MAX_WAIT_SECONDS) {
        return Err(format!(
            "--when-idle-timeout must be 1 to {} seconds",
            drain::MAX_WAIT_SECONDS
        )
        .into());
    }
    Ok(Activation {
        idle_timeout,
        force: flags.contains_key("force"),
    })
}
/// Returns true when this process handed the work to a detached copy of itself.
fn leave_t3_turn(ver: &str, flags: &BTreeMap<String, String>) -> Result<bool> {
    if flags.contains_key("detach") {
        // Its own turn is still running when the copy starts, so a plain idle check always refuses.
        if !flags.contains_key("when-idle-timeout") && !flags.contains_key("force") {
            return Err("--detach needs --when-idle-timeout or --force".into());
        }
        detach(ver)?;
        return Ok(true);
    }
    if env::var_os("T3CODE_THREAD_ID").is_some() {
        return Err(
            "This runs inside a T3 turn, which the restart would kill and which keeps the fleet \
             busy. Add --detach, then end the turn, or run from a terminal outside T3."
                .into(),
        );
    }
    Ok(false)
}

fn receipt_covers(receipt: &str, ver: &str, hosts: &[&str]) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(receipt) else {
        return false;
    };
    value["version"] == ver
        && hosts.iter().all(|host| {
            value["hosts"]
                .as_array()
                .is_some_and(|recorded| recorded.iter().any(|entry| entry == host))
        })
}
fn fleet_already_active(builds: &Path, ver: &str) -> bool {
    let hosts: Vec<&str> = std::iter::once("m5")
        .chain(remote_hosts().iter().copied())
        .collect();
    fs::read_to_string(builds.join("fleet-complete.json"))
        .is_ok_and(|receipt| receipt_covers(&receipt, ver, &hosts))
        && installed_version(Path::new("/Applications/T3 Code (Beta).app")).as_deref() == Some(ver)
}
/// Everything that activates comes through here, so a retry of an installed fleet changes nothing.
fn activate_with(ver: &str, builds: &Path, helper: &str, activation: Activation) -> Result<()> {
    if fleet_already_active(builds, ver) {
        println!("Fleet {ver} is already active; no host was changed.");
        return Ok(());
    }
    let Some(timeout_seconds) = activation.idle_timeout else {
        return activate_fleet(ver, builds, helper, activation.force);
    };
    drain::install_signal_handlers();
    let local = drain::LocalHost::current("m5")?;
    let remotes: Vec<drain::RemoteHost> = remote_hosts()
        .iter()
        .map(|name| drain::RemoteHost {
            name,
            helper: helper.to_string(),
        })
        .collect();
    let mut hosts: Vec<&dyn drain::DrainHost> = vec![&local];
    hosts.extend(remotes.iter().map(|host| host as &dyn drain::DrainHost));
    let owner = format!("fleet:{ver}:{}", std::process::id());
    let wait = local.wait_path();
    drain::acquire_hold(
        &wait,
        &owner,
        timeout_seconds + drain::ACTIVATION_GRACE_SECONDS,
        now_ms(),
    )?;
    println!(
        "Waiting up to {timeout_seconds} seconds for running turns. New turns stay allowed until \
         every host is idle, then pause only while switching."
    );
    let cancelled = || drain::interrupted() || !drain::holds(&wait, &owner, now_ms());
    let end = drain::drain_and_activate(
        &hosts,
        &owner,
        timeout_seconds,
        activation.force,
        &drain::SystemClock,
        &cancelled,
        &mut |force| activate_fleet(ver, builds, helper, force),
    );
    let _ = drain::release_hold(&wait, &owner);
    let end = end?;
    match end {
        drain::DrainEnd::Activated => Ok(()),
        drain::DrainEnd::TimedOut(waiting) => Err(format!(
            "Timed out waiting for {}. New turns are allowed again and nothing was switched.",
            waiting.join(", ")
        )
        .into()),
        drain::DrainEnd::Cancelled(reason) => Err(format!(
            "Cancelled: {reason}. New turns are allowed again and nothing was switched."
        )
        .into()),
    }
}
fn cancel_when_idle() -> Result<()> {
    let local = drain::LocalHost::current("m5")?;
    let Some(owner) =
        drain::hold_owner(&local.wait_path()).or_else(|| drain::hold_owner(&local.hold_path()))
    else {
        println!("No rollout is waiting or holding new turns on M5.");
        return Ok(());
    };
    drain::release_hold(&local.wait_path(), &owner)?;
    drain::release_hold(&local.hold_path(), &owner)?;
    // A dead rollout can't release the others, whose holds could otherwise last hours.
    let ver = owner.split(':').nth(1).ok_or("Unexpected hold owner")?;
    let helper = format!("/tmp/t3-fork-deploy-{ver}/target/release/t3-fork-deploy");
    for host in remote_hosts() {
        if let Err(error) = remote(host, &helper, &["host-release", "--owner", &owner]) {
            eprintln!("{host}: hold not released, it will expire: {error}");
        }
    }
    println!("Cancelled {owner}.");
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
fn fleet(ver: &str, upstream: &str, stage_only: bool, activation: Activation) -> Result<()> {
    runtime(ver)?;
    let connect = connect_build_environment()?;
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
    if !stage_only && activation.idle_timeout.is_none() && !activation.force {
        idle()?;
    }
    for host in remote_hosts() {
        ssh(host, "true")?;
    }
    if remote_hosts().contains(&"m3") {
        ssh("m3", "ssh -o BatchMode=yes -o ConnectTimeout=8 j true")?;
    }
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
    build_with_connect(
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
        &connect,
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
            build_with_connect(
                &[
                    "apps/server/scripts/cli.ts",
                    "build-exe",
                    "--target",
                    platform,
                ],
                &connect,
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
    distribute(ver, &builds, stage_only, activation)
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
        "scripts/",
        "docs/",
        "native/fork-deploy/",
        "native/agent-leases/",
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
        let status = Command::new("vp")
            .args(["run", "--filter", "@t3tools/web", "build"])
            .envs(connect_build_environment()?)
            .env("APP_VERSION", ver)
            .status()?;
        if !status.success() {
            return Err(format!("Web build failed: {status}").into());
        }
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
        if ["force", "detach"].contains(&key.as_str()) {
            flags.insert(key, String::new());
            continue;
        }
        if ![
            "version",
            "upstream-tag",
            "archive",
            "platform",
            "app",
            "base-dir",
            "built-client",
            "when-idle-timeout",
            "owner",
            "ttl-seconds",
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
            "fleet" => {
                let ver = get("version")?;
                let activation = parse_activation(&flags)?;
                if leave_t3_turn(ver, &flags)? {
                    return Ok(());
                }
                fleet(ver, get("upstream-tag")?, false, activation)
            }
            "fleet-stage" => fleet(
                get("version")?,
                get("upstream-tag")?,
                true,
                Activation::default(),
            ),
            "fleet-activate-cancel" => cancel_when_idle(),
            "host-hold" => drain::LocalHost::current("host").and_then(|host| {
                drain::acquire_hold(
                    &host.hold_path(),
                    get("owner")?,
                    get("ttl-seconds")?.parse()?,
                    now_ms(),
                )
            }),
            "host-release" => drain::LocalHost::current("host")
                .and_then(|host| drain::release_hold(&host.hold_path(), get("owner")?)),
            "host-probe" => {
                use drain::DrainHost;
                let probe = drain::LocalHost::current("host")?.probe(get("owner")?)?;
                println!("{}", drain::format_probe(&probe));
                Ok(())
            }
            "fleet-activate" => {
                let ver = get("version")?;
                runtime(ver)?;
                let activation = parse_activation(&flags)?;
                if leave_t3_turn(ver, &flags)? {
                    return Ok(());
                }
                let builds = home()?.join(".t3/builds").join(ver);
                let helper = prepare_helpers(ver)?;
                activate_with(ver, &builds, &helper, activation)
            }
            "host-stage" => stage(get("version")?, Path::new(get("archive")?)),
            // A host a previous attempt already moved is not what a retry waits for.
            "host-idle" => match flags.get("version") {
                Some(ver) if service_on(ver)? => Ok(()),
                _ => idle(),
            },
            "host-active" => {
                println!("{}", Value::from(active_runs(&state_db()?)?));
                Ok(())
            }
            "host-activate" => activate(get("version")?, flags.contains_key("force")),
            "host-verify" => verify(get("version")?),
            "hash" => {
                println!("{}", digest(Path::new(get("archive")?))?);
                Ok(())
            }
            "help" | "--help" => {
                println!(
                    "fork-deploy ui [--app PATH] [--base-dir PATH] [--built-client PATH]\nfork-deploy fleet --version VERSION --upstream-tag TAG [--when-idle-timeout SECONDS] [--force] [--detach]\nfork-deploy fleet-stage --version VERSION --upstream-tag TAG\nfork-deploy fleet-activate --version VERSION [--when-idle-timeout SECONDS] [--force] [--detach]\nfork-deploy fleet-activate-cancel\nWithout flags, activation refuses unless every host is idle. --when-idle-timeout pauses new turns and waits for idle; on timeout it allows turns again and switches nothing. --force interrupts what is still running, after the wait if given. --detach runs in the background so a T3 turn can start it and end. fleet-stage never activates; UI updates never restart servers."
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
    #[test]
    fn a_host_already_on_the_version_keeps_its_service_definition() {
        let service = "ExecStart=/home/u/.t3/runtime/versions/1.2.3/t3 serve";
        assert_eq!(
            service_with_version(service, "1.2.3").unwrap(),
            (service.to_string(), "1.2.3".to_string())
        );
        assert_ne!(service_with_version(service, "1.2.4").unwrap().0, service);
    }
    #[test]
    fn a_retry_treats_only_a_covering_receipt_as_already_active() {
        let receipt = r#"{"version":"1.2.3","hosts":["m5","j"]}"#;
        assert!(receipt_covers(receipt, "1.2.3", &["m5", "j"]));
        assert!(!receipt_covers(receipt, "1.2.3", &["m5", "m3", "j"]));
        assert!(!receipt_covers(receipt, "1.2.4", &["m5", "j"]));
        assert!(!receipt_covers("not json", "1.2.3", &["m5"]));
    }
    #[test]
    fn connect_build_refuses_missing_public_configuration() {
        let complete = BTreeMap::from([
            (
                CONNECT_KEYS[0].to_owned(),
                "https://relay.example.com".to_owned(),
            ),
            (CONNECT_KEYS[1].to_owned(), "pk_test_public".to_owned()),
            (CONNECT_KEYS[2].to_owned(), "public-cli-client".to_owned()),
        ]);
        assert!(validate_connect_environment(&complete).is_ok());
        for key in CONNECT_KEYS {
            let mut missing = complete.clone();
            missing.remove(key);
            assert!(validate_connect_environment(&missing).is_err());
            missing.insert(key.to_owned(), " ".to_owned());
            assert!(validate_connect_environment(&missing).is_err());
        }
    }
    pub(crate) fn temporary(name: &str) -> PathBuf {
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
    fn idle_query_retries_only_database_open_failures() {
        let mut attempts = 0;
        let result = read_idle_count(|| {
            attempts += 1;
            if attempts == 1 {
                Err("sqlite3: Parse error in 3rd command line argument: unable to open database file (14)".into())
            } else {
                Ok("2".into())
            }
        });
        assert_eq!(result.unwrap(), "2");
        assert_eq!(attempts, 2);
        let mut attempts = 0;
        assert!(
            read_idle_count(|| {
                attempts += 1;
                Err("no such table".into())
            })
            .is_err()
        );
        assert_eq!(attempts, 1);
        let mut attempts = 0;
        assert!(
            read_idle_count(|| {
                attempts += 1;
                Err("unable to open database file (14)".into())
            })
            .is_err()
        );
        assert_eq!(attempts, 10);
    }
    #[test]
    fn repeat_backup_keeps_the_first_snapshot() {
        let dir = temporary("backup");
        let db = dir.join("state.sqlite");
        run(
            "sqlite3",
            &[
                s(&db),
                "CREATE TABLE t(v TEXT); INSERT INTO t VALUES ('before');",
            ],
        )
        .unwrap();
        backup_at(&db, &dir.join("saved")).unwrap();
        run("sqlite3", &[s(&db), "UPDATE t SET v = 'after';"]).unwrap();
        backup_at(&db, &dir.join("saved")).unwrap();
        let saved = dir.join("saved/statev2.sqlite");
        assert_eq!(
            output("sqlite3", &["-readonly", s(&saved), "SELECT v FROM t"]).unwrap(),
            "before"
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn desktop_swap_never_quits_an_app_it_cannot_replace() {
        let ver = "1.2.3";
        assert!(!desktop_swap_needed(Some(ver), ver, true).unwrap());
        assert!(!desktop_swap_needed(Some(ver), ver, false).unwrap());
        assert!(desktop_swap_needed(Some("1.2.2"), ver, false).unwrap());
        assert!(desktop_swap_needed(Some("1.2.2"), ver, true).is_err());
        assert!(desktop_swap_needed(None, ver, true).is_err());
    }
    #[test]
    fn threads_in_a_live_holder_do_not_count_as_busy() {
        let dir = temporary("held");
        let db = run_database(&dir);
        set_run(&db, "t", "running", "{}");
        let holders = dir.join("agent-holders");
        fs::create_dir(&holders).unwrap();
        let dead = holders.join("999999.json");
        fs::write(&dead, r#"{"pid":999999,"threadIds":["t"]}"#).unwrap();
        assert!(idle_at(&db).is_err());
        fs::write(
            holders.join("self.json"),
            json!({"pid": std::process::id(), "threadIds": ["t"]}).to_string(),
        )
        .unwrap();
        idle_at(&db).unwrap();
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn a_cleanly_closed_wal_database_still_reads() {
        let dir = temporary("closed");
        let db = run_database(&dir);
        set_run(&db, "t", "running", "{}");
        run("sqlite3", &[s(&db), "PRAGMA journal_mode=WAL;"]).unwrap();
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{suffix}", db.display()));
        }
        assert!(
            idle_at(&db)
                .unwrap_err()
                .to_string()
                .contains("1 active turns")
        );
        fs::remove_dir_all(dir).unwrap();
    }
    fn run_database(dir: &Path) -> PathBuf {
        let db = dir.join("statev2.sqlite");
        run("sqlite3", &[s(&db), "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, title TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT, status TEXT, payload_json TEXT); INSERT INTO orchestration_v2_projection_threads VALUES ('t', 'Title', NULL, NULL, '{}'), ('old', 'Archived', 'then', NULL, '{}'); INSERT INTO orchestration_v2_projection_runs VALUES ('t', 'completed', '{}');"]).unwrap();
        db
    }
    fn set_run(db: &Path, thread: &str, status: &str, payload: &str) {
        run(
            "sqlite3",
            &[s(db), &format!("DELETE FROM orchestration_v2_projection_runs; INSERT INTO orchestration_v2_projection_runs VALUES ('{thread}', '{status}', '{payload}');")],
        )
        .unwrap();
    }
    #[test]
    fn idle_guard_refuses_work_that_will_run_and_ignores_queues_that_cannot() {
        let dir = temporary("idle");
        let db = run_database(&dir);
        idle_at(&db).unwrap();
        for status in ["queued", "preparing", "starting", "running", "waiting"] {
            set_run(&db, "t", status, "{}");
            assert!(idle_at(&db).is_err(), "{status}");
        }
        let runs = active_runs(&db).unwrap();
        assert_eq!(runs[0]["threadId"], "t");
        assert_eq!(runs[0]["title"], "Title");
        for (thread, payload) in [("t", r#"{"queueHeld":true}"#), ("old", "{}")] {
            set_run(&db, thread, "queued", payload);
            idle_at(&db).unwrap();
        }
        fs::remove_dir_all(dir).unwrap();
    }
    struct FakeService {
        db: PathBuf,
        bad_version: &'static str,
        log: std::cell::RefCell<Vec<String>>,
    }
    impl ServiceControl for FakeService {
        fn stop(&self) -> Result<()> {
            self.log.borrow_mut().push("stop".into());
            Ok(())
        }
        fn start(&self) -> Result<()> {
            self.log.borrow_mut().push("start".into());
            Ok(())
        }
        fn verify(&self, ver: &str) -> Result<()> {
            self.log.borrow_mut().push(format!("verify {ver}"));
            if ver == self.bad_version {
                // What a failed version's migrations leave behind.
                run("sqlite3", &[s(&self.db), "CREATE TABLE migrated(x);"])?;
                return Err("never came up".into());
            }
            Ok(())
        }
    }
    fn switch_fixture(dir: &Path, db: &Path) -> SwitchPaths {
        let service = dir.join("t3code.service");
        fs::write(
            &service,
            "ExecStart=/h/.t3/runtime/versions/1.0.0-preview.20260101.1/t3 serve\n",
        )
        .unwrap();
        let launcher = dir.join("t3");
        std::os::unix::fs::symlink("/old/t3", &launcher).unwrap();
        SwitchPaths {
            service,
            db: db.to_owned(),
            backup: dir.join("backup"),
            launcher,
            runtime: PathBuf::from("/new"),
        }
    }
    #[test]
    fn a_version_that_never_comes_up_restores_service_link_and_database() {
        let dir = temporary("rollback");
        let db = run_database(&dir);
        let paths = switch_fixture(&dir, &db);
        let bad = "2.0.0-preview.20260101.1";
        let control = FakeService {
            db: db.clone(),
            bad_version: bad,
            log: Default::default(),
        };
        let error = switch_service(bad, &paths, &control)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("rolled back to 1.0.0-preview.20260101.1"),
            "{error}"
        );
        assert!(
            fs::read_to_string(&paths.service)
                .unwrap()
                .contains("1.0.0-preview.20260101.1")
        );
        assert!(!paths.backup.join("statev2.sqlite").exists());
        assert_eq!(
            fs::read_link(&paths.launcher).unwrap(),
            Path::new("/old/t3")
        );
        assert_eq!(
            output(
                "sqlite3",
                &[
                    "-readonly",
                    s(&db),
                    "SELECT count(*) FROM sqlite_master WHERE name = 'migrated'"
                ]
            )
            .unwrap(),
            "0"
        );
        assert_eq!(
            *control.log.borrow(),
            [
                "stop",
                "start",
                &format!("verify {bad}"),
                "stop",
                "start",
                "verify 1.0.0-preview.20260101.1"
            ]
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn switching_to_the_running_version_only_restarts_and_verifies_so_retries_are_safe() {
        let dir = temporary("retry");
        let db = run_database(&dir);
        let paths = switch_fixture(&dir, &db);
        let control = FakeService {
            db: db.clone(),
            bad_version: "",
            log: Default::default(),
        };
        switch_service("1.0.0-preview.20260101.1", &paths, &control).unwrap();
        assert_eq!(
            *control.log.borrow(),
            ["start", "verify 1.0.0-preview.20260101.1"]
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
