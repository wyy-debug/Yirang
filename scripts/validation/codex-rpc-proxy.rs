// Test-only stdio proxy. It withholds the first turn/start response and every
// subsequent stdout message so the desktop can be killed after Codex accepted
// a real request but before the desktop receives any turn receipt.
use std::env;
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

fn json_id(line: &str) -> Option<u64> {
    let rest = line.split_once("\"id\":")?.1.trim_start();
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().ok()
}

fn main() -> io::Result<()> {
    let real = env::var("YIRANG_PROXY_REAL_BIN").map_err(io::Error::other)?;
    let signal = env::var("YIRANG_PROXY_SIGNAL_FILE").map_err(io::Error::other)?;
    let mut child = Command::new(real)
        .args(env::args().skip(1))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let mut real_stdin = child.stdin.take().ok_or_else(|| io::Error::other("stdin"))?;
    let real_stdout = child.stdout.take().ok_or_else(|| io::Error::other("stdout"))?;
    let real_stderr = child.stderr.take().ok_or_else(|| io::Error::other("stderr"))?;
    let held_id = Arc::new(Mutex::new(None::<u64>));
    let stdout_id = held_id.clone();
    let stdout_thread = thread::spawn(move || -> io::Result<()> {
        let mut output = io::stdout().lock();
        for item in BufReader::new(real_stdout).lines() {
            let line = item?;
            let held = *stdout_id.lock().map_err(|_| io::Error::other("lock"))?;
            if let Some(id) = held {
                if json_id(&line) == Some(id) &&
                    (line.contains("\"result\"") || line.contains("\"error\"")) {
                    fs::write(&signal, &line)?;
                }
                continue;
            }
            writeln!(output, "{line}")?;
            output.flush()?;
        }
        Ok(())
    });
    let stderr_thread = thread::spawn(move || {
        let _ = io::copy(&mut BufReader::new(real_stderr), &mut io::stderr());
    });
    for item in io::stdin().lock().lines() {
        let line = item?;
        if line.contains("\"method\":\"turn/start\"") {
            if let Some(id) = json_id(&line) {
                *held_id.lock().map_err(|_| io::Error::other("lock"))? = Some(id);
            }
        }
        writeln!(real_stdin, "{line}")?;
        real_stdin.flush()?;
    }
    let _ = child.kill();
    let _ = child.wait();
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();
    Ok(())
}
