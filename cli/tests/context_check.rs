use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::process::{Command, Output, Stdio};

fn run(input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_warble"))
        .arg("check-context")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    // Oversize input may close stdin as soon as the byte bound is reached.
    let _ = child.stdin.take().unwrap().write_all(input);
    child.wait_with_output().unwrap()
}

#[test]
fn check_context_is_bound_to_exact_request_bytes() {
    let request = json!({"version":1,"context":{"context_version":2,"parseable":true},
        "preconditions":[{"predicate":"mdl_parseable"}]})
    .to_string();
    let output = run(request.as_bytes());
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        response,
        json!({"version":1,"status":"pass",
        "request_sha256":format!("{:x}",Sha256::digest(request.as_bytes()))})
    );
}

#[test]
fn check_context_refuses_invalid_versions_contexts_and_requests() {
    for request in [
        json!({"version":2,"context":{"context_version":2,"parseable":true},"preconditions":[]}),
        json!({"version":1,"context":{"context_version":999,"parseable":true},"preconditions":[]}),
        json!({"version":1,"context":{"context_version":2,"parseable":false},"preconditions":[{"predicate":"mdl_parseable"}]}),
        json!({"version":1,"context":{"context_version":2,"parseable":true},"preconditions":[{"predicate":"source_introspectable"}]}),
        json!({"version":1,"context":{"context_version":2,"parseable":true},"preconditions":[],"pass":true}),
    ] {
        let output = run(request.to_string().as_bytes());
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    assert!(!run(b"not JSON").status.success());
    assert!(!run(&vec![b' '; 2 * 1024 * 1024 + 1]).status.success());
}
