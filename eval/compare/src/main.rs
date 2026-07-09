use std::io::{self, Read, Write};
use std::process::ExitCode;

use warble_eval_compare::{compare, CompareRequest, CompareResult};

fn run() -> Result<CompareResult, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| format!("failed to read stdin: {e}"))?;
    let request: CompareRequest =
        serde_json::from_str(&input).map_err(|e| format!("invalid input JSON: {e}"))?;
    Ok(compare(&request))
}

fn main() -> ExitCode {
    match run() {
        Ok(result) => {
            let output = serde_json::to_string(&result).expect("result always serializes");
            println!("{output}");
            ExitCode::SUCCESS
        }
        Err(err) => {
            let result = CompareResult {
                pass: false,
                reason: err,
            };
            let output = serde_json::to_string(&result).expect("result always serializes");
            let _ = writeln!(io::stderr(), "{output}");
            ExitCode::FAILURE
        }
    }
}
