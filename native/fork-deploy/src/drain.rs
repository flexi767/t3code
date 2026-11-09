use crate::{Result, active_turns_at, home, now_ms, output, quote, sqlite_has_writer, ssh};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::Duration,
};

const HOLD_FILE: &str = "turn-admission-hold.json";
/// Marks a waiting rollout without pausing turns, so a cancel can find and end it.
const WAIT_FILE: &str = "fleet-activation-wait.json";
const POLL_INTERVAL: Duration = Duration::from_secs(2);
/// Covers activation after the wait; a dead deploy restores admission once this passes.
pub const ACTIVATION_GRACE_SECONDS: u64 = 900;
pub const MAX_WAIT_SECONDS: u64 = 4 * 60 * 60;

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
extern "C" fn on_signal(_: i32) {
    INTERRUPTED.store(true, Ordering::SeqCst);
}
unsafe extern "C" {
    fn signal(signum: i32, handler: extern "C" fn(i32)) -> usize;
}
pub fn install_signal_handlers() {
    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    // SAFETY: the handler only stores to an atomic, which is async-signal-safe.
    unsafe {
        signal(SIGINT, on_signal);
        signal(SIGTERM, on_signal);
    }
}
pub fn interrupted() -> bool {
    INTERRUPTED.load(Ordering::SeqCst)
}

fn read_hold(path: &Path) -> Option<(String, u64)> {
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some((
        value["owner"].as_str()?.to_string(),
        value["expiresAtMs"].as_u64()?,
    ))
}

/// A hard link is an atomic create, so two rollouts cannot both believe they own the hold.
pub fn acquire_hold(path: &Path, owner: &str, ttl_seconds: u64, now: u64) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(
        &temporary,
        json!({"owner": owner, "expiresAtMs": now + ttl_seconds * 1000}).to_string(),
    )?;
    let result = (|| -> Result<()> {
        for _ in 0..2 {
            match fs::hard_link(&temporary, path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() != std::io::ErrorKind::AlreadyExists => {
                    return Err(error.into());
                }
                Err(_) => {}
            }
            match read_hold(path) {
                Some((current, expires)) if expires > now && current != owner => {
                    return Err(format!("Another rollout is in progress: {current}").into());
                }
                Some((current, expires)) if expires > now && current == owner => {
                    fs::rename(&temporary, path)?;
                    return Ok(());
                }
                _ => fs::remove_file(path)?,
            }
        }
        Err("Could not claim the turn admission hold".into())
    })();
    let _ = fs::remove_file(&temporary);
    result
}

pub fn holds(path: &Path, owner: &str, now: u64) -> bool {
    read_hold(path).is_some_and(|(current, expires)| current == owner && expires > now)
}
pub fn hold_owner(path: &Path) -> Option<String> {
    read_hold(path).map(|(owner, _)| owner)
}

/// Only the owner can restore admission, so a late cleanup cannot end another rollout's hold.
pub fn release_hold(path: &Path, owner: &str) -> Result<()> {
    if read_hold(path).is_some_and(|(current, _)| current == owner) {
        fs::remove_file(path)?;
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
pub enum Probe {
    Active(u64),
    HoldLost,
}

/// Every commit that passed the old gate holds SQLite's write lock until it finishes. Taking the
/// lock once after the hold exists means any later commit sees the hold, so the count is final.
pub fn probe_at(hold: &Path, db: &Path, owner: &str, now: u64) -> Result<Probe> {
    if !holds(hold, owner, now) {
        return Ok(Probe::HoldLost);
    }
    if sqlite_has_writer(db) {
        output(
            "sqlite3",
            &[
                "-cmd",
                ".timeout 30000",
                crate::s(db),
                "BEGIN IMMEDIATE; COMMIT;",
            ],
        )?;
    }
    Ok(Probe::Active(active_turns_at(db)?))
}

pub trait DrainHost {
    fn name(&self) -> &str;
    fn hold(&self, owner: &str, ttl_seconds: u64) -> Result<()>;
    fn release(&self, owner: &str) -> Result<()>;
    fn probe(&self, owner: &str) -> Result<Probe>;
    /// Active turns without pausing admission; only the held probe can prove a host idle.
    fn count(&self) -> Result<u64>;
}

pub struct LocalHost {
    pub name: String,
    pub state_dir: PathBuf,
}
impl LocalHost {
    pub fn current(name: &str) -> Result<Self> {
        Ok(Self {
            name: name.into(),
            state_dir: home()?.join(".t3/userdata"),
        })
    }
    pub fn hold_path(&self) -> PathBuf {
        self.state_dir.join(HOLD_FILE)
    }
    pub fn wait_path(&self) -> PathBuf {
        self.state_dir.join(WAIT_FILE)
    }
}
impl DrainHost for LocalHost {
    fn name(&self) -> &str {
        &self.name
    }
    fn hold(&self, owner: &str, ttl_seconds: u64) -> Result<()> {
        acquire_hold(&self.hold_path(), owner, ttl_seconds, now_ms())
    }
    fn release(&self, owner: &str) -> Result<()> {
        release_hold(&self.hold_path(), owner)
    }
    fn probe(&self, owner: &str) -> Result<Probe> {
        probe_at(
            &self.hold_path(),
            &self.state_dir.join("statev2.sqlite"),
            owner,
            now_ms(),
        )
    }
    fn count(&self) -> Result<u64> {
        active_turns_at(&self.state_dir.join("statev2.sqlite"))
    }
}

pub struct RemoteHost {
    pub name: &'static str,
    pub helper: String,
}
impl RemoteHost {
    fn command(&self, args: &[&str]) -> Result<String> {
        ssh(
            self.name,
            &std::iter::once(self.helper.as_str())
                .chain(args.iter().copied())
                .map(quote)
                .collect::<Vec<_>>()
                .join(" "),
        )
    }
}
impl DrainHost for RemoteHost {
    fn name(&self) -> &str {
        self.name
    }
    fn hold(&self, owner: &str, ttl_seconds: u64) -> Result<()> {
        let ttl = ttl_seconds.to_string();
        self.command(&["host-hold", "--owner", owner, "--ttl-seconds", &ttl])?;
        Ok(())
    }
    fn release(&self, owner: &str) -> Result<()> {
        self.command(&["host-release", "--owner", owner])?;
        Ok(())
    }
    fn probe(&self, owner: &str) -> Result<Probe> {
        parse_probe(&self.command(&["host-probe", "--owner", owner])?)
    }
    fn count(&self) -> Result<u64> {
        let runs: Vec<Value> = serde_json::from_str(&self.command(&["host-active"])?)?;
        Ok(runs.len() as u64)
    }
}
pub fn format_probe(probe: &Probe) -> String {
    match probe {
        Probe::Active(count) => count.to_string(),
        Probe::HoldLost => "hold-lost".into(),
    }
}
fn parse_probe(text: &str) -> Result<Probe> {
    if text == "hold-lost" {
        return Ok(Probe::HoldLost);
    }
    Ok(Probe::Active(text.parse()?))
}

pub trait Clock {
    fn now_ms(&self) -> u64;
    fn sleep(&self, duration: Duration);
}
pub struct SystemClock;
impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        now_ms()
    }
    fn sleep(&self, duration: Duration) {
        thread::sleep(duration);
    }
}

#[derive(Debug, PartialEq)]
pub enum DrainEnd {
    Activated,
    TimedOut(Vec<String>),
    Cancelled(String),
}

/// Waits for every host to look idle without pausing anything, then pauses all of them and
/// confirms under the write lock before activating. A turn that slipped in before the pause
/// ends the pause and the wait goes on. Only `force_on_timeout` stops a turn, and every path
/// that does not activate restores admission; a probe that cannot prove a host idle counts as busy.
pub fn drain_and_activate(
    hosts: &[&dyn DrainHost],
    owner: &str,
    timeout_seconds: u64,
    force_on_timeout: bool,
    clock: &dyn Clock,
    cancelled: &dyn Fn() -> bool,
    activate: &mut dyn FnMut(bool) -> Result<()>,
) -> Result<DrainEnd> {
    let ttl = ACTIVATION_GRACE_SECONDS;
    let release_all = |hosts: &[&dyn DrainHost]| {
        for host in hosts {
            if let Err(error) = host.release(owner) {
                eprintln!(
                    "Could not end the hold on {}; it expires by itself within {ttl} seconds: {error}",
                    host.name()
                );
            }
        }
    };
    let deadline = clock.now_ms() + timeout_seconds * 1000;
    loop {
        if cancelled() {
            return Ok(DrainEnd::Cancelled("interrupted".into()));
        }
        let expired = clock.now_ms() >= deadline;
        let mut waiting = Vec::new();
        for host in hosts {
            match host.count() {
                Ok(0) => {}
                Ok(count) => waiting.push(format!("{}: {count}", host.name())),
                Err(error) => waiting.push(format!("{}: {error}", host.name())),
            }
        }
        if !waiting.is_empty() && !expired {
            clock.sleep(POLL_INTERVAL);
            continue;
        }
        if !waiting.is_empty() && !force_on_timeout {
            return Ok(DrainEnd::TimedOut(waiting));
        }
        for (index, host) in hosts.iter().enumerate() {
            if let Err(error) = host.hold(owner, ttl) {
                release_all(&hosts[..index]);
                return Err(error);
            }
        }
        let mut busy = false;
        let mut lost = None;
        for host in hosts {
            match host.probe(owner) {
                Ok(Probe::Active(0)) => {}
                Ok(Probe::HoldLost) => lost = Some(host.name().to_string()),
                Ok(Probe::Active(_)) | Err(_) => busy = true,
            }
        }
        let end = if let Some(name) = lost {
            Some(Ok(DrainEnd::Cancelled(format!("the hold on {name} ended"))))
        } else if !busy {
            Some(activate(false).map(|()| DrainEnd::Activated))
        } else if expired && force_on_timeout {
            Some(activate(true).map(|()| DrainEnd::Activated))
        } else {
            None
        };
        release_all(hosts);
        if let Some(end) = end {
            return end;
        }
        clock.sleep(POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
        sync::mpsc,
    };

    const RUNS: &str = "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT, title TEXT, archived_at TEXT, deleted_at TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_runs(thread_id TEXT, status TEXT, payload_json TEXT);";

    struct FakeHost {
        name: &'static str,
        probes: RefCell<Vec<Result<Probe>>>,
        log: RefCell<Vec<String>>,
        refuse_hold: bool,
    }
    fn fake(name: &'static str, probes: Vec<Result<Probe>>) -> FakeHost {
        FakeHost {
            name,
            probes: RefCell::new(probes),
            log: RefCell::new(vec![]),
            refuse_hold: false,
        }
    }
    impl DrainHost for FakeHost {
        fn name(&self) -> &str {
            self.name
        }
        fn hold(&self, _: &str, _: u64) -> Result<()> {
            if self.refuse_hold {
                return Err("refused".into());
            }
            self.log.borrow_mut().push("hold".into());
            Ok(())
        }
        fn release(&self, _: &str) -> Result<()> {
            self.log.borrow_mut().push("release".into());
            Ok(())
        }
        fn probe(&self, _: &str) -> Result<Probe> {
            self.log.borrow_mut().push("probe".into());
            self.next()
        }
        fn count(&self) -> Result<u64> {
            self.log.borrow_mut().push("count".into());
            match self.next()? {
                Probe::Active(count) => Ok(count),
                Probe::HoldLost => Ok(0),
            }
        }
    }
    impl FakeHost {
        fn next(&self) -> Result<Probe> {
            let mut probes = self.probes.borrow_mut();
            if probes.len() > 1 {
                probes.remove(0)
            } else {
                match &probes[0] {
                    Ok(Probe::Active(count)) => Ok(Probe::Active(*count)),
                    Ok(Probe::HoldLost) => Ok(Probe::HoldLost),
                    Err(error) => Err(error.to_string().into()),
                }
            }
        }
    }
    struct FakeClock(Cell<u64>);
    impl Clock for FakeClock {
        fn now_ms(&self) -> u64 {
            self.0.get()
        }
        fn sleep(&self, duration: Duration) {
            self.0.set(self.0.get() + duration.as_millis() as u64);
        }
    }

    fn run_drain(hosts: &[&dyn DrainHost], timeout: u64) -> (Result<DrainEnd>, u32) {
        let clock = FakeClock(Cell::new(0));
        let mut activations = 0;
        let end = drain_and_activate(
            hosts,
            "owner",
            timeout,
            false,
            &clock,
            &|| false,
            &mut |_| {
                activations += 1;
                Ok(())
            },
        );
        (end, activations)
    }

    #[test]
    fn waits_for_every_host_then_activates_once_and_restores_admission() {
        let m5 = fake("m5", vec![Ok(Probe::Active(2)), Ok(Probe::Active(0))]);
        let j = fake(
            "j",
            vec![
                Ok(Probe::Active(1)),
                Ok(Probe::Active(1)),
                Ok(Probe::Active(0)),
            ],
        );
        let (end, activations) = run_drain(&[&m5, &j], 60);
        assert_eq!(end.unwrap(), DrainEnd::Activated);
        assert_eq!(activations, 1);
        assert_eq!(
            *j.log.borrow(),
            ["count", "count", "count", "hold", "probe", "release"],
            "new turns stay allowed until every host looks idle"
        );
    }
    #[test]
    fn a_turn_that_starts_before_the_pause_keeps_the_rollout_waiting() {
        let m5 = fake(
            "m5",
            vec![
                Ok(Probe::Active(0)),
                Ok(Probe::Active(1)),
                Ok(Probe::Active(1)),
                Ok(Probe::Active(0)),
            ],
        );
        let (end, activations) = run_drain(&[&m5], 60);
        assert_eq!(end.unwrap(), DrainEnd::Activated);
        assert_eq!(activations, 1);
        assert_eq!(
            *m5.log.borrow(),
            [
                "count", "hold", "probe", "release", "count", "count", "hold", "probe", "release"
            ]
        );
    }
    #[test]
    fn timeout_never_activates_and_restores_admission() {
        let m5 = fake("m5", vec![Ok(Probe::Active(0))]);
        let j = fake("j", vec![Ok(Probe::Active(3))]);
        let (end, activations) = run_drain(&[&m5, &j], 10);
        assert_eq!(end.unwrap(), DrainEnd::TimedOut(vec!["j: 3".into()]));
        assert_eq!(activations, 0);
        for host in [&m5, &j] {
            assert!(!host.log.borrow().contains(&"hold".to_string()));
        }
    }
    #[test]
    fn force_on_timeout_activates_as_forced_and_restores_admission() {
        let m5 = fake("m5", vec![Ok(Probe::Active(1))]);
        let clock = FakeClock(Cell::new(0));
        let mut forced = Vec::new();
        let end = drain_and_activate(&[&m5], "owner", 1, true, &clock, &|| false, &mut |force| {
            forced.push(force);
            Ok(())
        });
        assert_eq!(end.unwrap(), DrainEnd::Activated);
        assert_eq!(forced, [true]);
        assert_eq!(m5.log.borrow().last().unwrap(), "release");
    }

    #[test]
    fn an_unreadable_host_counts_as_busy() {
        let j = fake("j", vec![Err("ssh down".into())]);
        let (end, activations) = run_drain(&[&j], 4);
        assert_eq!(end.unwrap(), DrainEnd::TimedOut(vec!["j: ssh down".into()]));
        assert_eq!(activations, 0);
    }
    #[test]
    fn a_removed_hold_cancels_without_activating() {
        let m5 = fake("m5", vec![Ok(Probe::Active(0))]);
        let j = fake("j", vec![Ok(Probe::HoldLost)]);
        let (end, activations) = run_drain(&[&m5, &j], 60);
        assert_eq!(
            end.unwrap(),
            DrainEnd::Cancelled("the hold on j ended".into())
        );
        assert_eq!(activations, 0);
        assert_eq!(m5.log.borrow().last().unwrap(), "release");
    }
    #[test]
    fn a_signal_cancels_without_activating() {
        let m5 = fake("m5", vec![Ok(Probe::Active(1))]);
        let clock = FakeClock(Cell::new(0));
        let polls = Cell::new(0);
        let cancelled = || {
            polls.set(polls.get() + 1);
            polls.get() > 2
        };
        let mut activate = |_: bool| -> Result<()> { panic!("must not activate") };
        let end = drain_and_activate(
            &[&m5],
            "owner",
            60,
            false,
            &clock,
            &cancelled,
            &mut activate,
        );
        assert_eq!(end.unwrap(), DrainEnd::Cancelled("interrupted".into()));
        assert!(!m5.log.borrow().contains(&"hold".to_string()));
    }
    #[test]
    fn a_refused_hold_releases_earlier_hosts_without_waiting() {
        let m5 = fake("m5", vec![Ok(Probe::Active(0))]);
        let mut j = fake("j", vec![Ok(Probe::Active(0))]);
        j.refuse_hold = true;
        let (end, activations) = run_drain(&[&m5, &j], 60);
        assert!(end.is_err());
        assert_eq!(activations, 0);
        assert_eq!(*m5.log.borrow(), vec!["count", "hold", "release"]);
    }
    #[test]
    fn a_failed_activation_still_restores_admission() {
        let m5 = fake("m5", vec![Ok(Probe::Active(0))]);
        let clock = FakeClock(Cell::new(0));
        let mut activate = |_: bool| -> Result<()> { Err("activation failed".into()) };
        let end = drain_and_activate(&[&m5], "owner", 60, false, &clock, &|| false, &mut activate);
        assert!(end.is_err());
        assert_eq!(m5.log.borrow().last().unwrap(), "release");
    }

    #[test]
    fn hold_ownership_expiry_and_probe_results() {
        let dir = crate::tests::temporary("hold");
        let hold = dir.join(HOLD_FILE);
        let db = dir.join("absent.sqlite");
        acquire_hold(&hold, "a", 10, 1_000).unwrap();
        assert!(acquire_hold(&hold, "b", 10, 2_000).is_err());
        acquire_hold(&hold, "a", 20, 2_000).unwrap();
        assert_eq!(read_hold(&hold).unwrap(), ("a".to_string(), 22_000));
        assert_eq!(probe_at(&hold, &db, "b", 2_000).unwrap(), Probe::HoldLost);
        assert_eq!(probe_at(&hold, &db, "a", 22_000).unwrap(), Probe::HoldLost);
        release_hold(&hold, "b").unwrap();
        assert!(hold.exists());
        acquire_hold(&hold, "b", 10, 22_000).unwrap();
        release_hold(&hold, "b").unwrap();
        assert!(!hold.exists());
        fs::remove_dir_all(dir).unwrap();
    }

    /// The commit that won the race is still writing when the hold appears: the probe must wait
    /// for it and count its run rather than report idle.
    #[test]
    fn probe_waits_for_a_commit_that_passed_the_gate_before_the_hold() {
        let dir = crate::tests::temporary("race");
        let db = dir.join("statev2.sqlite");
        let hold = dir.join(HOLD_FILE);
        crate::run(
            "sqlite3",
            &[crate::s(&db), &format!("PRAGMA journal_mode=WAL; {RUNS}")],
        )
        .unwrap();
        let mut writer = Command::new("sqlite3")
            .arg(&db)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = writer.stdin.take().unwrap();
        writeln!(
            stdin,
            "BEGIN IMMEDIATE; INSERT INTO orchestration_v2_projection_runs VALUES ('t', 'starting', '{{}}'); SELECT 'ready';"
        )
        .unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        BufReader::new(writer.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "ready");

        acquire_hold(&hold, "owner", 60, now_ms()).unwrap();
        let (sent, received) = mpsc::channel();
        let (probe_hold, probe_db) = (hold.clone(), db.clone());
        let probing = thread::spawn(move || {
            let result = probe_at(&probe_hold, &probe_db, "owner", now_ms()).unwrap();
            sent.send(result).unwrap();
        });
        assert!(
            received.recv_timeout(Duration::from_millis(300)).is_err(),
            "the probe must wait for the open write transaction"
        );
        writeln!(stdin, "COMMIT;").unwrap();
        drop(stdin);
        writer.wait().unwrap();
        assert_eq!(received.recv().unwrap(), Probe::Active(1));
        probing.join().unwrap();
        fs::remove_dir_all(dir).unwrap();
    }

    /// Real hold file and database, with a simulated activation.
    #[test]
    fn local_drain_activates_only_after_the_last_run_finishes() {
        let dir = crate::tests::temporary("local");
        let db = dir.join("statev2.sqlite");
        crate::run(
            "sqlite3",
            &[
                crate::s(&db),
                &format!(
                    "PRAGMA journal_mode=WAL; {RUNS} INSERT INTO orchestration_v2_projection_runs VALUES ('t', 'running', '{{}}');"
                ),
            ],
        )
        .unwrap();
        let host = LocalHost {
            name: "m5".into(),
            state_dir: dir.clone(),
        };
        struct FinishingClock<'a>(&'a Path, Cell<u64>);
        impl Clock for FinishingClock<'_> {
            fn now_ms(&self) -> u64 {
                self.1.get()
            }
            fn sleep(&self, duration: Duration) {
                assert!(
                    !self.0.with_file_name(HOLD_FILE).exists(),
                    "new turns stay allowed while a run is active"
                );
                self.1.set(self.1.get() + duration.as_millis() as u64);
                crate::run(
                    "sqlite3",
                    &[
                        crate::s(self.0),
                        "UPDATE orchestration_v2_projection_runs SET status = 'completed';",
                    ],
                )
                .unwrap();
            }
        }
        let clock = FinishingClock(&db, Cell::new(0));
        let hold = host.hold_path();
        let activated = Cell::new(0);
        let mut activate = |_: bool| -> Result<()> {
            assert!(hold.exists(), "turns stay held through activation");
            assert_eq!(active_turns_at(&db)?, 0);
            activated.set(activated.get() + 1);
            Ok(())
        };
        let end = drain_and_activate(
            &[&host],
            "owner",
            60,
            false,
            &clock,
            &|| false,
            &mut activate,
        );
        assert_eq!(end.unwrap(), DrainEnd::Activated);
        assert_eq!(activated.get(), 1);
        assert!(!hold.exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
