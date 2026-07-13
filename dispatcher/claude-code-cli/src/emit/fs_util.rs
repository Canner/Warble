//! Filesystem write helpers shared by the emit paths — thin wrappers that map I/O errors into
//! `DispatchError` with the offending path.

use crate::error::DispatchError;
use std::fs;
use std::path::Path;

pub(super) fn write_file(path: &Path, contents: &str) -> Result<(), DispatchError> {
    fs::write(path, contents)
        .map_err(|e| DispatchError(format!("failed to write {}: {e}", path.display())))
}

pub(super) fn write_json(path: &Path, value: &serde_json::Value) -> Result<(), DispatchError> {
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(value).map_err(|e| DispatchError(e.to_string()))?
    );
    write_file(path, &rendered)
}

pub(super) fn mkdir_all(path: &Path) -> Result<(), DispatchError> {
    fs::create_dir_all(path)
        .map_err(|e| DispatchError(format!("failed to create {}: {e}", path.display())))
}
