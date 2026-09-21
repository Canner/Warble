use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::io::Read;

const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: u32,
    context: serde_json::Value,
    preconditions: serde_json::Value,
}

pub fn run() -> Result<(), String> {
    let mut input = Vec::new();
    std::io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut input)
        .map_err(|_| "cannot read context verification request".to_string())?;
    if input.len() as u64 > MAX_REQUEST_BYTES {
        return Err("context verification request is too large".into());
    }
    let request: Request = serde_json::from_slice(&input)
        .map_err(|_| "invalid context verification request".to_string())?;
    if request.version != 1 {
        return Err("unsupported context verification version".into());
    }
    let context = warble::PreparedContext::from_json(&request.context.to_string())
        .map_err(|_| "invalid prepared context".to_string())?;
    warble::verify_context_preconditions(&request.preconditions, &context)
        .map_err(|error| error.to_string())?;
    println!(
        "{}",
        serde_json::json!({
            "version": 1,
            "status": "pass",
            "request_sha256": format!("{:x}", Sha256::digest(&input)),
        })
    );
    Ok(())
}
