//! Shared, deliberately small handoff contract for native interactive CLIs.

use crate::error::DispatchError;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

pub const LAUNCH_SPEC_VERSION: &str = "1";

pub struct InteractiveOutput {
    pub root: PathBuf,
    pub launch_path: PathBuf,
    pub handoff_path: PathBuf,
    ownership_path: PathBuf,
    owned_paths: Vec<String>,
    marker: String,
    target: String,
    executable: String,
}

pub fn prepare_interactive_output(
    out_dir: &Path,
    target: &str,
    executable: &str,
    profile_signature: &str,
    owned_paths: &[PathBuf],
) -> Result<InteractiveOutput, DispatchError> {
    if !out_dir.is_dir() {
        return Err(DispatchError(format!(
            "interactive dispatch output must be an existing directory so it can become the canonical launch cwd: {}",
            out_dir.display()
        )));
    }
    let root = fs::canonicalize(out_dir).map_err(|e| {
        DispatchError(format!(
            "canonicalize interactive output {}: {e}",
            out_dir.display()
        ))
    })?;
    let handoff_path = root.join("RUN.md");
    let launch_path = root.join(".warble/interactive-launch.json");
    ensure_inside(&root, &handoff_path)?;
    ensure_inside(&root, &launch_path)?;
    ensure_safe_path(&root, Path::new(".warble/interactive-launch.json"))?;
    ensure_safe_path(&root, Path::new(".warble/interactive-ownership.json"))?;
    let marker =
        format!("<!-- warble-interactive-artifact target={target} profile={profile_signature} -->");

    let mut planned = owned_paths
        .iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>();
    planned.sort();
    planned.dedup();
    let ownership_path = root.join(".warble/interactive-ownership.json");
    ensure_inside(&root, &ownership_path)?;
    for relative in owned_paths {
        ensure_safe_path(&root, relative)?;
    }
    let any_existing = planned.iter().any(|relative| root.join(relative).exists())
        || launch_path.exists()
        || ownership_path.exists();
    if any_existing {
        let existing = fs::read_to_string(&ownership_path).map_err(|_| {
            DispatchError(format!(
                "refusing to overwrite existing interactive artifacts: {} is missing",
                ownership_path.display()
            ))
        })?;
        verify_ownership(&existing, &marker, &planned, &root)?;
    }
    for relative in owned_paths {
        let path = root.join(relative);
        if path.exists()
            && matches!(
                path.file_name().and_then(|name| name.to_str()),
                Some("RUN.md" | "AGENTS.md" | "SKILL.md")
            )
        {
            let contents = fs::read_to_string(&path).map_err(|e| {
                DispatchError(format!(
                    "read existing interactive artifact {}: {e}",
                    path.display()
                ))
            })?;
            if !contents.contains(&marker) {
                return Err(DispatchError(format!(
                    "refusing to overwrite user-owned interactive artifact {}; it lacks the expected Warble ownership marker",
                    path.display()
                )));
            }
        }
    }
    if launch_path.exists() {
        let existing = fs::read_to_string(&launch_path).map_err(|e| {
            DispatchError(format!(
                "read existing launch spec {}: {e}",
                launch_path.display()
            ))
        })?;
        if existing != render_launch_spec(target, executable, &root, &handoff_path)? {
            return Err(DispatchError(format!(
                "refusing to overwrite user-owned or mismatched launch spec {}",
                launch_path.display()
            )));
        }
    }
    Ok(InteractiveOutput {
        root,
        launch_path,
        handoff_path,
        ownership_path,
        owned_paths: planned,
        marker,
        target: target.into(),
        executable: executable.into(),
    })
}

impl InteractiveOutput {
    pub fn marker(&self) -> &str {
        &self.marker
    }
    pub fn write_launch_spec(&self) -> Result<(), DispatchError> {
        let parent = self.launch_path.parent().expect(".warble parent");
        fs::create_dir_all(parent)
            .map_err(|e| DispatchError(format!("create {}: {e}", parent.display())))?;
        fs::write(
            &self.launch_path,
            render_launch_spec(
                &self.target,
                &self.executable,
                &self.root,
                &self.handoff_path,
            )?,
        )
        .map_err(|e| {
            DispatchError(format!(
                "write launch spec {}: {e}",
                self.launch_path.display()
            ))
        })
    }
    pub fn write_ownership(&self) -> Result<(), DispatchError> {
        let parent = self.ownership_path.parent().expect(".warble parent");
        fs::create_dir_all(parent)
            .map_err(|e| DispatchError(format!("create {}: {e}", parent.display())))?;
        fs::write(
            &self.ownership_path,
            ownership_document(&self.marker, &self.owned_paths, &self.root)?,
        )
        .map_err(|e| {
            DispatchError(format!(
                "write ownership record {}: {e}",
                self.ownership_path.display()
            ))
        })
    }
}

fn ensure_inside(root: &Path, path: &Path) -> Result<(), DispatchError> {
    if !path.starts_with(root) {
        return Err(DispatchError(format!(
            "interactive artifact path escapes canonical output root: {}",
            path.display()
        )));
    }
    Ok(())
}

/// Reject unsafe existing path components before any output write. A lexical `starts_with` check
/// is not a containment proof when `.claude`, `.agents`, or `.warble` can redirect writes
/// elsewhere, and a regular-file parent would make creation order-dependent.
fn ensure_safe_path(root: &Path, relative: &Path) -> Result<(), DispatchError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(DispatchError(format!(
            "interactive artifact path escapes canonical output root: {}",
            relative.display()
        )));
    }
    let components = relative.components().collect::<Vec<_>>();
    let mut cursor = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        cursor.push(component.as_os_str());
        if let Ok(metadata) = fs::symlink_metadata(&cursor) {
            if metadata.file_type().is_symlink() {
                return Err(DispatchError(format!(
                    "refusing interactive artifact path with symlink component: {}",
                    cursor.display()
                )));
            }
            if index + 1 < components.len() && !metadata.file_type().is_dir() {
                return Err(DispatchError(format!(
                    "refusing interactive artifact path with non-directory ancestor component: {}",
                    cursor.display()
                )));
            }
        }
    }
    Ok(())
}

fn render_launch_spec(
    target: &str,
    executable: &str,
    root: &Path,
    handoff: &Path,
) -> Result<String, DispatchError> {
    ensure_inside(root, handoff)?;
    // This is intentionally the entire schema: no command string, prompt/model material, auth,
    // provider state, or session identity can be represented here.
    serde_json::to_string_pretty(&json!({
        "version": LAUNCH_SPEC_VERSION,
        "target": target,
        "executable": executable,
        "argv": [],
        "cwd": root,
        "artifact_root": root,
        "handoff_path": handoff,
    }))
    .map(|v| format!("{v}\n"))
    .map_err(|e| DispatchError(e.to_string()))
}

fn ownership_document(
    marker: &str,
    paths: &[String],
    root: &Path,
) -> Result<String, DispatchError> {
    let artifacts = paths
        .iter()
        .map(|path| {
            let bytes = fs::read(root.join(path))
                .map_err(|e| DispatchError(format!("read owned artifact {path}: {e}")))?;
            Ok(json!({ "path": path, "sha256": format!("{:x}", Sha256::digest(bytes)) }))
        })
        .collect::<Result<Vec<_>, DispatchError>>()?;
    serde_json::to_string_pretty(&json!({ "marker": marker, "artifacts": artifacts }))
        .map(|v| format!("{v}\n"))
        .map_err(|e| DispatchError(e.to_string()))
}

fn verify_ownership(
    existing: &str,
    marker: &str,
    paths: &[String],
    root: &Path,
) -> Result<(), DispatchError> {
    let value: serde_json::Value = serde_json::from_str(existing).map_err(|_| {
        DispatchError("refusing to overwrite malformed interactive ownership record".to_string())
    })?;
    if value.get("marker").and_then(serde_json::Value::as_str) != Some(marker) {
        return Err(DispatchError("refusing to overwrite artifacts not owned by this exact Warble interactive emission plan".to_string()));
    }
    let artifacts = value
        .get("artifacts")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            DispatchError(
                "refusing to overwrite ownership record without per-artifact digests".to_string(),
            )
        })?;
    if artifacts.len() != paths.len() {
        return Err(DispatchError(
            "refusing to overwrite ownership record with a different artifact plan".to_string(),
        ));
    }
    for (artifact, path) in artifacts.iter().zip(paths) {
        if artifact.get("path").and_then(serde_json::Value::as_str) != Some(path.as_str()) {
            return Err(DispatchError(
                "refusing to overwrite ownership record with a different artifact plan".to_string(),
            ));
        }
        let bytes = fs::read(root.join(path)).map_err(|_| {
            DispatchError(format!(
                "refusing to overwrite missing owned artifact {path}"
            ))
        })?;
        let digest = format!("{:x}", Sha256::digest(bytes));
        if artifact.get("sha256").and_then(serde_json::Value::as_str) != Some(digest.as_str()) {
            return Err(DispatchError(format!(
                "refusing to overwrite modified owned artifact {path}"
            )));
        }
    }
    Ok(())
}
