//! `warble mcp-serve` — a minimal stdio MCP server for the file target's hybrid (mcp-server)
//! realization of `llm:per_step_provider`. It exposes ONE tool, `local_infer(step, input)`, that runs
//! a binding's LOCAL step on an OpenAI-compatible endpoint (e.g. ollama). Registered by the emitted
//! `.mcp.json`; the driver agent (run by `claude`) calls it for local steps while cloud steps stay the
//! driver's own `wren` work. Unlike the skill-shell realization, the local call is an MCP tool — a
//! separate permission gate — so it needs NO `bash` in the read-only agent's allowlist (the cleaner
//! realization; capability-model.md §7.2).
//!
//! Transport: newline-delimited JSON-RPC 2.0 over stdin/stdout (the MCP stdio transport). Only the
//! `tools` capability is advertised, so only `initialize` / `notifications/initialized` / `ping` /
//! `tools/list` / `tools/call` are expected; anything else returns a JSON-RPC method-not-found.
//! stdout carries ONLY protocol messages; diagnostics go to stderr.

use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::Path;
use std::process::Command;

const TOOL_NAME: &str = "local_infer";
const DEFAULT_PROTOCOL_VERSION: &str = "2024-11-05";

/// One local step's binding + baked system prompt (the endpoint/model never leave the server, so the
/// driver prompt stays provider-agnostic).
#[derive(Debug, Clone)]
pub struct StepCfg {
    pub endpoint: String,
    pub model: String,
    pub system: String,
}

/// The emitted `mcp-steps.json`: local step name → its binding + system prompt.
#[derive(Debug, Clone)]
pub struct Steps {
    pub steps: BTreeMap<String, StepCfg>,
}

impl Steps {
    /// Parse the `{ "steps": { "<name>": { endpoint, model, system } } }` document (no serde derive —
    /// the `cli` crate depends on serde_json only).
    fn from_value(doc: &Value) -> Result<Steps, String> {
        let obj = doc
            .get("steps")
            .and_then(Value::as_object)
            .ok_or_else(|| "mcp-steps: expected a `steps` object".to_string())?;
        let mut steps = BTreeMap::new();
        for (name, cfg) in obj {
            let field = |k: &str| -> Result<String, String> {
                cfg.get(k)
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| format!("mcp-steps: step '{name}' is missing string `{k}`"))
            };
            steps.insert(
                name.clone(),
                StepCfg {
                    endpoint: field("endpoint")?,
                    model: field("model")?,
                    system: field("system")?,
                },
            );
        }
        Ok(Steps { steps })
    }

    fn load(path: &Path) -> Result<Steps, String> {
        let raw =
            std::fs::read_to_string(path).map_err(|e| format!("read {}: {e}", path.display()))?;
        let doc: Value =
            serde_json::from_str(&raw).map_err(|e| format!("parse {}: {e}", path.display()))?;
        Steps::from_value(&doc)
    }
}

/// Call an OpenAI-compatible chat endpoint via `curl` (no HTTP-client dependency). Returns the
/// assistant text. Kept as a boundary so [`handle_request`] can be unit-tested with a stub.
fn infer_via_curl(cfg: &StepCfg, user: &str) -> Result<String, String> {
    let body = json!({
        "model": cfg.model,
        "messages": [
            {"role": "system", "content": cfg.system},
            {"role": "user", "content": user},
        ],
        "stream": false,
        "temperature": 0,
    })
    .to_string();
    let url = format!("{}/chat/completions", cfg.endpoint.trim_end_matches('/'));
    let out = Command::new("curl")
        .args([
            "-s",
            "-X",
            "POST",
            &url,
            "-H",
            "content-type: application/json",
            "-d",
            &body,
        ])
        .output()
        .map_err(|e| format!("spawn curl: {e}"))?;
    if !out.status.success() {
        return Err(format!("curl exited {}", out.status));
    }
    let v: Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("parse local response: {e}"))?;
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "local response had no choices[0].message.content".to_string())
}

fn result(id: &Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn tool_schema() -> Value {
    json!({
        "name": TOOL_NAME,
        "description": "Run one named LOCAL step of this task on its configured local model and return \
    its text output. `step` is the step name; `input` is the marshaled input text (the question and/or the \
    previous step's output).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "step": { "type": "string", "description": "the step name to run locally" },
                "input": { "type": "string", "description": "marshaled input text for the step" }
            },
            "required": ["step", "input"]
        }
    })
}

/// Handle one JSON-RPC request against the loaded steps, using `infer` for the actual local call.
/// Returns the response value, or `None` for notifications (no response is written). Pure except for
/// `infer`, so the protocol is unit-testable offline with a stub.
pub fn handle_request(
    req: &Value,
    steps: &Steps,
    infer: &dyn Fn(&StepCfg, &str) -> Result<String, String>,
) -> Option<Value> {
    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    match method {
        "initialize" => {
            // Echo the client's protocol version for maximum compatibility.
            let protocol = req
                .get("params")
                .and_then(|p| p.get("protocolVersion"))
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_PROTOCOL_VERSION);
            Some(result(
                &id,
                json!({
                    "protocolVersion": protocol,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "warble", "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
        }
        // Notifications carry no id and get no response.
        "notifications/initialized" | "initialized" => None,
        "ping" => Some(result(&id, json!({}))),
        "tools/list" => Some(result(&id, json!({ "tools": [tool_schema()] }))),
        "tools/call" => {
            let params = req.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            if name != TOOL_NAME {
                return Some(error(&id, -32602, &format!("unknown tool '{name}'")));
            }
            let args = params.get("arguments").cloned().unwrap_or(Value::Null);
            let step = args.get("step").and_then(Value::as_str).unwrap_or("");
            let input = args.get("input").and_then(Value::as_str).unwrap_or("");
            let (text, is_error) = match steps.steps.get(step) {
                Some(cfg) => match infer(cfg, input) {
                    Ok(t) => (t, false),
                    Err(e) => (format!("local_infer error for step '{step}': {e}"), true),
                },
                None => (
                    format!(
                        "unknown local step '{step}' (known: {})",
                        steps.steps.keys().cloned().collect::<Vec<_>>().join(", ")
                    ),
                    true,
                ),
            };
            Some(result(
                &id,
                json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }),
            ))
        }
        // Notification (no id) for an unknown method → ignore; a request → method-not-found.
        _ => {
            if req.get("id").is_some() {
                Some(error(&id, -32601, &format!("method not found: {method}")))
            } else {
                None
            }
        }
    }
}

/// Run the stdio server loop: read newline-delimited JSON-RPC from stdin, write responses to stdout.
pub fn run_mcp_serve(steps_path: &Path) -> Result<(), String> {
    let steps = Steps::load(steps_path)?;
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    eprintln!(
        "warble mcp-serve: ready ({} local step(s): {})",
        steps.steps.len(),
        steps.steps.keys().cloned().collect::<Vec<_>>().join(", ")
    );
    for line in stdin.lock().lines() {
        let line = line.map_err(|e| format!("read stdin: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(e) => {
                eprintln!("warble mcp-serve: skipping non-JSON line: {e}");
                continue;
            }
        };
        if let Some(resp) = handle_request(&req, &steps, &infer_via_curl) {
            let mut s = resp.to_string();
            s.push('\n');
            stdout
                .write_all(s.as_bytes())
                .map_err(|e| format!("write stdout: {e}"))?;
            stdout.flush().map_err(|e| format!("flush stdout: {e}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn steps() -> Steps {
        let doc = json!({"steps":{"resolve_intent":{"endpoint":"http://localhost:11434/v1","model":"qwen2.5","system":"resolve the intent"}}});
        Steps::from_value(&doc).expect("steps parse")
    }
    fn stub_ok(_c: &StepCfg, user: &str) -> Result<String, String> {
        Ok(format!("intent for: {user}"))
    }

    #[test]
    fn initialize_echoes_protocol_and_advertises_tools() {
        let req = json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}});
        let resp = handle_request(&req, &steps(), &stub_ok).expect("response");
        assert_eq!(resp["result"]["protocolVersion"], "2025-06-18");
        assert!(resp["result"]["capabilities"]["tools"].is_object());
        assert_eq!(resp["result"]["serverInfo"]["name"], "warble");
    }

    #[test]
    fn initialized_notification_has_no_response() {
        let req = json!({"jsonrpc":"2.0","method":"notifications/initialized"});
        assert!(handle_request(&req, &steps(), &stub_ok).is_none());
    }

    #[test]
    fn tools_list_exposes_local_infer_with_schema() {
        let req = json!({"jsonrpc":"2.0","id":2,"method":"tools/list"});
        let resp = handle_request(&req, &steps(), &stub_ok).expect("response");
        let tool = &resp["result"]["tools"][0];
        assert_eq!(tool["name"], TOOL_NAME);
        assert_eq!(tool["inputSchema"]["required"][0], "step");
    }

    #[test]
    fn tools_call_runs_the_step_via_infer() {
        let req = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"local_infer","arguments":{"step":"resolve_intent","input":"how many orders"}}});
        let resp = handle_request(&req, &steps(), &stub_ok).expect("response");
        assert_eq!(resp["result"]["isError"], false);
        assert_eq!(
            resp["result"]["content"][0]["text"],
            "intent for: how many orders"
        );
    }

    #[test]
    fn tools_call_unknown_step_is_a_tool_error_not_a_crash() {
        let req = json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"local_infer","arguments":{"step":"nope","input":"x"}}});
        let resp = handle_request(&req, &steps(), &stub_ok).expect("response");
        assert_eq!(resp["result"]["isError"], true);
        assert!(resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("unknown local step"));
    }

    #[test]
    fn unknown_method_with_id_is_method_not_found() {
        let req = json!({"jsonrpc":"2.0","id":5,"method":"resources/list"});
        let resp = handle_request(&req, &steps(), &stub_ok).expect("response");
        assert_eq!(resp["error"]["code"], -32601);
    }
}
