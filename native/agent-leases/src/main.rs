use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    io::Write,
    process::{Command, Stdio},
};

type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;

const HELP: &str = "t3-agent-lease <list|claim|renew|release> --repo owner/repository [options]
  claim:   --package relative/path --owner thread-or-session-id --summary task
           [--host name] [--worktree path] [--ttl 900]
  renew:   --owner id --lease UUID --generation N [--ttl 900]
  release: --owner id --lease UUID --generation N
  --local  Connect directly to J's Unix-socket Postgres (automatic on host j).
Prints JSON. Exit 2: conflict; exit 3: lease lost; exit 1: request/service error.
Claim before editing; renew at checkpoints before expiry; release when finished.
On conflict, lost lease or service failure, stop edits to the claimed scope.";

fn output(program: &str, args: &[&str]) -> Result<String> {
    let result = Command::new(program).args(args).output()?;
    if !result.status.success() {
        return Err(format!("{program}: {}", String::from_utf8_lossy(&result.stderr)).into());
    }
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}

fn request(args: &[String]) -> Result<(Value, bool)> {
    let action = args.first().ok_or(HELP)?;
    if !["list", "claim", "renew", "release"].contains(&action.as_str()) {
        return Err(HELP.into());
    }
    let mut options = BTreeMap::new();
    let mut local = false;
    let mut i = 1;
    while i < args.len() {
        let key = args[i].as_str();
        if key == "--local" {
            local = true;
            i += 1;
            continue;
        }
        if ![
            "--repo",
            "--package",
            "--owner",
            "--summary",
            "--host",
            "--worktree",
            "--ttl",
            "--lease",
            "--generation",
        ]
        .contains(&key)
        {
            return Err(format!("Unknown option: {key}").into());
        }
        let value = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or("Missing option value")?;
        if options.insert(key, value.as_str()).is_some() {
            return Err(format!("Duplicate option: {key}").into());
        }
        i += 2;
    }
    let required = |key| {
        options
            .get(key)
            .copied()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| format!("{key} is required"))
    };
    let mut value = json!({"action": action, "repository": required("--repo")?});
    if action == "list" {
        if options.keys().any(|k| *k != "--repo") {
            return Err("list only accepts --repo and --local".into());
        }
        return Ok((value, local));
    }
    value["owner"] = json!(required("--owner")?);
    if action == "claim" {
        value["package"] = json!(required("--package")?);
        value["summary"] = json!(required("--summary")?);
        value["host"] = json!(match options.get("--host") {
            Some(name) => (*name).to_owned(),
            None => output("hostname", &["-s"])?,
        });
        value["worktree"] = json!(match options.get("--worktree") {
            Some(path) => (*path).to_owned(),
            None => env::current_dir()?.display().to_string(),
        });
        if options.contains_key("--lease") || options.contains_key("--generation") {
            return Err("claim returns a new lease and generation; do not supply them".into());
        }
    } else {
        value["leaseId"] = json!(required("--lease")?);
        value["generation"] = json!(required("--generation")?.parse::<u64>()?);
        if options
            .keys()
            .any(|k| ["--package", "--summary", "--host", "--worktree"].contains(k))
        {
            return Err(
                "renew/release use the original lease and generation, not package metadata".into(),
            );
        }
    }
    if let Some(ttl) = options.get("--ttl") {
        let ttl: u32 = ttl.parse()?;
        if action == "release" || !(30..=3600).contains(&ttl) {
            return Err("--ttl is 30..3600 seconds, for claim or renew".into());
        }
        value["ttlSeconds"] = json!(ttl);
    }
    Ok((value, local))
}

fn sql(request: &Value) -> String {
    // JSON escapes newlines; doubled quotes plus standard strings keep data out of SQL/psql syntax.
    let literal = request.to_string().replace('\'', "''");
    format!(
        "SET standard_conforming_strings = on;\nSET statement_timeout = '10s';\nSET lock_timeout = '5s';\nSELECT agent_coordination.lease('{literal}'::jsonb);\n"
    )
}

fn query(request: &Value, local: bool) -> Result<Value> {
    let mut command = if local {
        let mut command = Command::new("psql");
        command.args([
            "-XqAt",
            "-v",
            "ON_ERROR_STOP=1",
            "-h",
            "/var/run/postgresql",
            "-d",
            "t3_agent_coordination",
        ]);
        command
    } else {
        let mut command = Command::new("ssh");
        command.args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=8",
            "-o",
            "ServerAliveInterval=10",
            "-o",
            "ServerAliveCountMax=2",
            "j",
            "psql -XqAt -v ON_ERROR_STOP=1 -h /var/run/postgresql -d t3_agent_coordination",
        ]);
        command
    };
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let written = child
        .stdin
        .take()
        .ok_or("Missing child stdin")?
        .write_all(sql(request).as_bytes());
    let result = child.wait_with_output()?;
    if !result.status.success() {
        return Err(format!(
            "Lease registry unavailable or request refused: {}",
            String::from_utf8_lossy(&result.stderr)
        )
        .into());
    }
    written?;
    Ok(serde_json::from_slice(&result.stdout)?)
}

fn run() -> Result<i32> {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.is_empty() || args == ["--help"] {
        println!("{HELP}");
        return Ok(0);
    }
    let (request, local) = request(&args)?;
    let result = query(&request, local || output("hostname", &["-s"])? == "j")?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    match result["status"].as_str() {
        Some("listed" | "claimed" | "renewed" | "released") => Ok(0),
        Some("conflict") => Ok(2),
        Some("lost") => Ok(3),
        _ => Err("Unexpected registry response".into()),
    }
}

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claim_and_rejects_ambiguous_or_incomplete_requests() {
        let parse =
            |args: &[&str]| request(&args.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        let (value, local) = parse(&[
            "claim",
            "--repo",
            "acme/app",
            "--package",
            "packages/api",
            "--owner",
            "thread-1",
            "--summary",
            "Fix 'API'\nbehavior",
            "--worktree",
            "/repo",
            "--host",
            "m5",
            "--ttl",
            "120",
            "--local",
        ])
        .unwrap();
        assert!(local);
        assert_eq!(value["ttlSeconds"], 120);
        assert_eq!(value["summary"], "Fix 'API'\nbehavior");
        for args in [
            vec!["claim", "--repo", "acme/app"],
            vec!["list", "--repo", "a", "--repo", "b"],
            vec!["list", "--repo", "a", "--owner", "x"],
            vec![
                "release",
                "--repo",
                "a",
                "--owner",
                "x",
                "--lease",
                "id",
                "--generation",
                "1",
                "--ttl",
                "900",
            ],
        ] {
            assert!(parse(&args).is_err(), "{args:?}");
        }
        let encoded = sql(&value);
        assert!(encoded.contains("Fix ''API''\\nbehavior"));
        assert!(encoded.contains("standard_conforming_strings = on"));
    }

    #[test]
    #[ignore = "requires J's installed coordination database and SSH access"]
    fn concurrent_overlapping_claims_have_one_winner() {
        use std::sync::{Arc, Barrier};
        let repo = format!(
            "lease-test/concurrent-{}-{}",
            output("hostname", &["-s"]).unwrap().to_lowercase(),
            std::process::id()
        );
        let barrier = Arc::new(Barrier::new(2));
        let workers: Vec<_> = ["packages/api", "packages/api/src"].into_iter().enumerate().map(|(i, package)| {
            let barrier = Arc::clone(&barrier);
            let request = json!({"action":"claim", "repository":repo, "package":package, "owner":format!("test-{i}"), "host":"test", "worktree":"/test", "summary":"concurrent overlap test", "ttlSeconds":30});
            std::thread::spawn(move || {
                barrier.wait();
                query(&request, false).unwrap()
            })
        }).collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let winner = results.iter().find(|r| r["status"] == "claimed").unwrap();
        let lease = &winner["lease"];
        let released = query(&json!({"action":"release", "repository":repo, "owner":lease["owner"], "leaseId":lease["lease_id"], "generation":lease["generation"]}), false).unwrap();
        assert_eq!(released["status"], "released");
        assert_eq!(
            results.iter().filter(|r| r["status"] == "claimed").count(),
            1
        );
        assert_eq!(
            results.iter().filter(|r| r["status"] == "conflict").count(),
            1
        );
    }
}
