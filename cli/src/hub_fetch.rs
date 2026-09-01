//! Fetches the Hub component library over the network into a per-user cache, when there is no
//! in-repo `hub/components/` to prefer instead (see [`crate::in_repo_hub_dir`] and
//! [`crate::default_component_sources`]).
//!
//! Resolution order, decided in `decision-82`: a profile's own `components/` (Local, highest
//! precedence) beats the user cache, which beats fetching the central Hub fresh. This module only
//! implements the last two steps — filling and trusting the cache.
//!
//! Everything here is in-process: `ureq` + `rustls` for HTTPS (no shelling out to `curl`/`wget`,
//! absent from `debian:bookworm-slim`), `flate2` + `tar` for archive handling (no shelling out to
//! system `tar`). The Hub ships as one `hub-<version>.tar.gz` archive per release, unpacking to
//! component directories at its top level (`answer_query/component.yml`, not
//! `components/answer_query/component.yml`).
//!
//! ## Cache trust
//!
//! A prior, abandoned design cached to the world-writable, fully-derivable-path shared temp
//! directory and returned early on a bare `.complete` sentinel — never verifying content or
//! ownership. A local actor could pre-plant a poisoned cache at that guessable path and every
//! later compile would silently use it (reproduced end to end: a canary in a cached step file
//! appeared twice in the emitted IR). This module closes that vector two ways:
//!
//! - The cache root is a **per-user** directory (the platform user cache dir, never the shared
//!   temp dir), created owner-only (`0o700` on unix).
//! - A cache hit is decided by **recomputing the SHA-256 of the on-disk archive** and comparing it
//!   against the on-disk checksum sidecar, every time — not by checking whether a marker file
//!   exists. Any mismatch, or a missing/malformed file on either side, is treated as a cache miss
//!   and triggers a fresh fetch. The `extracted/` directory is always deleted and re-derived from
//!   the now-verified archive, never trusted as pre-existing content, so a directly-planted file
//!   under `extracted/` (bypassing the archive and its checksum entirely) cannot survive either.

use std::fs;
use std::io::Read as _;
use std::path::{Path, PathBuf};

/// Where the CLI fetches Hub release archives from by default: `Canner/Warble`'s GitHub Releases.
/// Overridable via `WARBLE_HUB_BASE_URL`, which is the seam tests use to point at a local fixture
/// server instead of the network.
const DEFAULT_BASE_URL: &str = "https://github.com/Canner/Warble/releases/download";

/// Environment variable that overrides [`DEFAULT_BASE_URL`]. Test-only in practice, but not
/// `#[cfg(test)]`-gated: a host air-gapped from GitHub but mirroring releases internally can use it
/// too.
const BASE_URL_ENV: &str = "WARBLE_HUB_BASE_URL";

/// Environment variable that overrides the per-user cache root discovered by [`user_cache_root`].
/// Test-only in practice (lets a poisoning test plant a corrupt cache in a controlled tempdir
/// without touching the real developer cache), but not `#[cfg(test)]`-gated for the same reason as
/// [`BASE_URL_ENV`].
const CACHE_ROOT_ENV: &str = "WARBLE_HUB_CACHE_ROOT";

/// Rejects anything that is not a plain `MAJOR.MINOR.PATCH` numeric triplet (an optional
/// `-prerelease`/`+build` suffix is allowed but not inspected). This exists specifically to reject
/// mutable refs like `"main"` or `"latest"` as a Hub version: decision-82 requires a fixed,
/// checksum-verifiable version, never a moving target with no hash to verify against.
pub fn validate_hub_version(version: &str) -> Result<(), String> {
    let core = version
        .split(['-', '+'])
        .next()
        .expect("split always yields at least one segment");
    let parts: Vec<&str> = core.split('.').collect();
    let is_numeric_triplet = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if is_numeric_triplet {
        Ok(())
    } else {
        Err(format!(
            "'{version}' is not a valid Hub version (expected a fixed MAJOR.MINOR.PATCH, e.g. \
             '0.7.0') — a mutable ref such as 'main' or 'latest' cannot be checksum-verified and is \
             rejected; pass a released Warble version, or use --hub-dir to point at a local Hub \
             checkout instead"
        ))
    }
}

/// The base URL Hub release archives are fetched from — `WARBLE_HUB_BASE_URL` if set (the test
/// seam), else [`DEFAULT_BASE_URL`].
fn base_url() -> String {
    std::env::var(BASE_URL_ENV).unwrap_or_else(|_| DEFAULT_BASE_URL.to_string())
}

/// The archive and checksum-sidecar URLs for `version`, matching the release layout published
/// alongside this decision: tag `v<version>` carries `hub-<version>.tar.gz` and
/// `hub-<version>.tar.gz.sha256` assets.
fn archive_urls(version: &str) -> (String, String) {
    let base = base_url();
    let archive = format!("{base}/v{version}/hub-{version}.tar.gz");
    let checksum = format!("{archive}.sha256");
    (archive, checksum)
}

/// The platform per-user cache directory, before the `warble/hub` suffix. Never the shared temp
/// directory — see the module-level cache-trust discussion. `WARBLE_HUB_CACHE_ROOT` overrides this
/// outright (the test seam); otherwise this is the ordinary platform convention, hand-rolled rather
/// than pulling in a directories crate for one lookup.
fn user_cache_root() -> Result<PathBuf, String> {
    if let Ok(root) = std::env::var(CACHE_ROOT_ENV) {
        return Ok(PathBuf::from(root));
    }
    #[cfg(target_os = "macos")]
    {
        let home = std::env::var("HOME").map_err(|_| {
            "cannot determine a cache directory: $HOME is unset — set WARBLE_HUB_CACHE_ROOT to a \
             writable directory, or use --hub-dir to point at a local Hub checkout instead"
                .to_string()
        })?;
        Ok(PathBuf::from(home).join("Library").join("Caches"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CACHE_HOME") {
            if !xdg.is_empty() {
                return Ok(PathBuf::from(xdg));
            }
        }
        let home = std::env::var("HOME").map_err(|_| {
            "cannot determine a cache directory: neither $XDG_CACHE_HOME nor $HOME is set — set \
             WARBLE_HUB_CACHE_ROOT to a writable directory, or use --hub-dir to point at a local \
             Hub checkout instead"
                .to_string()
        })?;
        Ok(PathBuf::from(home).join(".cache"))
    }
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").map_err(|_| {
            "cannot determine a cache directory: %LOCALAPPDATA% is unset — set \
             WARBLE_HUB_CACHE_ROOT to a writable directory, or use --hub-dir to point at a local \
             Hub checkout instead"
                .to_string()
        })?;
        Ok(PathBuf::from(local_app_data))
    }
    #[cfg(not(any(unix, windows)))]
    {
        Err(
            "cannot determine a cache directory on this platform — set WARBLE_HUB_CACHE_ROOT to a \
             writable directory, or use --hub-dir to point at a local Hub checkout instead"
                .to_string(),
        )
    }
}

/// Create `dir` (and its parents) owner-only. On unix this sets `0o700` after creation — the
/// per-user, not-world-writable requirement from decision-82 — and re-asserts the mode even if the
/// directory already existed, so an inherited looser mode does not silently persist. Windows has no
/// POSIX mode bits; per-user separation there comes from `%LOCALAPPDATA%` already being
/// user-scoped by the platform.
fn create_private_dir_all(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| {
        format!(
            "could not create the Hub cache directory {} ({e}) — check that the location is \
             writable, set {CACHE_ROOT_ENV} to a writable directory, or use --hub-dir to point at \
             a local Hub checkout instead",
            dir.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).map_err(|e| {
            format!(
                "could not set owner-only permissions on the Hub cache directory {} ({e}) — check \
                 that you own the directory, set {CACHE_ROOT_ENV} to a writable directory, or use \
                 --hub-dir to point at a local Hub checkout instead",
                dir.display()
            )
        })?;
    }
    Ok(())
}

/// Reads `path` and returns its lowercase-hex SHA-256, or `None` if it cannot be read at all
/// (missing, permissions, etc.) — treated as a cache miss by the caller, not a hard error.
fn sha256_of_file(path: &Path) -> Option<String> {
    use sha2::{Digest, Sha256};
    let mut file = fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut file, &mut hasher).ok()?;
    Some(format!("{:x}", hasher.finalize()))
}

/// Parses a `<hex-digest>  hub-<version>.tar.gz`-shaped checksum sidecar (the conventional
/// `sha256sum` output format) down to just the hex digest, tolerating a bare hex digest with no
/// filename too. Returns `None` if the content is not recognizably a hex digest.
fn parse_checksum_sidecar(content: &str) -> Option<String> {
    let digest = content.split_whitespace().next()?;
    let is_hex =
        !digest.is_empty() && digest.len() == 64 && digest.chars().all(|c| c.is_ascii_hexdigit());
    is_hex.then(|| digest.to_ascii_lowercase())
}

/// Fetches `url`'s full response body as bytes, mapping ureq's error shape onto the two
/// user-facing failure modes decision-82 calls out: an HTTP status (most importantly 404, "no
/// asset for this version") versus every other transport/IO failure ("unreachable network").
fn fetch_bytes(url: &str) -> Result<Vec<u8>, FetchError> {
    match ureq::get(url).call() {
        Ok(mut response) => {
            let mut bytes = Vec::new();
            response
                .body_mut()
                .as_reader()
                .read_to_end(&mut bytes)
                .map_err(|e| FetchError::Unreachable(e.to_string()))?;
            Ok(bytes)
        }
        Err(ureq::Error::StatusCode(code)) => Err(FetchError::Status(code)),
        Err(e) => Err(FetchError::Unreachable(e.to_string())),
    }
}

enum FetchError {
    Status(u16),
    Unreachable(String),
}

/// Writes `bytes` to `dest` via a temp-file-then-atomic-rename in the same directory, so a failed
/// or partial write never contaminates `dest` (and a concurrent reader either sees the old content
/// or the new content in full, never a torn write).
fn write_atomically(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = dest
        .parent()
        .ok_or_else(|| format!("{} has no parent directory to write into", dest.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        dest.file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("download"),
        std::process::id()
    ));
    fs::write(&tmp, bytes).map_err(|e| format!("failed to write {} ({e})", tmp.display()))?;
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("failed to finalize {} ({e})", dest.display())
    })
}

/// Ensures the Hub for `version` is present, verified, and extracted under the per-user cache,
/// fetching it over the network if needed. Returns the path to the extracted component directory
/// (containing `<id>/component.yml` entries at its top level, ready to hand to
/// [`crate::ComponentSource::hub`]).
///
/// Cache layout per version: `<cache_root>/warble/hub/<version>/{hub-<version>.tar.gz,
/// hub-<version>.tar.gz.sha256, extracted/}`. A hit is decided by recomputing the archive's SHA-256
/// against the sidecar every call — see the module-level cache-trust discussion for why. `extracted/`
/// is always rebuilt fresh from the verified archive, regardless of hit or miss.
pub fn ensure_cached_hub(version: &str) -> Result<PathBuf, String> {
    validate_hub_version(version)?;

    let cache_root = user_cache_root()?;
    let version_dir = cache_root.join("warble").join("hub").join(version);
    create_private_dir_all(&version_dir)?;

    let archive_path = version_dir.join(format!("hub-{version}.tar.gz"));
    let checksum_path = version_dir.join(format!("hub-{version}.tar.gz.sha256"));
    let (archive_url, checksum_url) = archive_urls(version);

    let cached_digest = fs::read_to_string(&checksum_path)
        .ok()
        .and_then(|s| parse_checksum_sidecar(&s));
    let on_disk_digest = sha256_of_file(&archive_path);
    let cache_hit = matches!((&cached_digest, &on_disk_digest), (Some(a), Some(b)) if a == b);

    if !cache_hit {
        let archive_bytes = fetch_bytes(&archive_url).map_err(|e| match e {
            FetchError::Status(404) => format!(
                "no Hub archive is published for version {version} at {archive_url} (HTTP 404) — \
                 this Warble release may predate the Hub-fetch archive, or --hub-version points at \
                 a version that never shipped one; use --hub-dir to point at a local Hub checkout \
                 instead"
            ),
            FetchError::Status(code) => format!(
                "fetching the Hub archive for v{version} from {archive_url} failed with HTTP \
                 {code} — use --hub-dir to point at a local Hub checkout instead"
            ),
            FetchError::Unreachable(detail) => format!(
                "could not reach {archive_url} to fetch Hub v{version} ({detail}) — check your \
                 network connection, or use --hub-dir to point at a local Hub checkout instead"
            ),
        })?;
        let checksum_text = fetch_bytes(&checksum_url)
            .map_err(|e| match e {
                FetchError::Status(404) => format!(
                    "no checksum is published for Hub version {version} at {checksum_url} (HTTP \
                     404) — this Warble release may predate the Hub-fetch archive, or \
                     --hub-version points at a version that never shipped one; use --hub-dir to \
                     point at a local Hub checkout instead"
                ),
                FetchError::Status(code) => format!(
                    "fetching the Hub checksum for v{version} from {checksum_url} failed with \
                     HTTP {code} — use --hub-dir to point at a local Hub checkout instead"
                ),
                FetchError::Unreachable(detail) => format!(
                    "could not reach {checksum_url} to fetch the Hub v{version} checksum ({detail}) \
                     — check your network connection, or use --hub-dir to point at a local Hub \
                     checkout instead"
                ),
            })
            .and_then(|bytes| {
                String::from_utf8(bytes)
                    .map_err(|e| format!("the published checksum for Hub v{version} is not valid text ({e})"))
            })?;
        let expected_digest = parse_checksum_sidecar(&checksum_text).ok_or_else(|| {
            format!(
                "the published checksum for Hub v{version} at {checksum_url} is not a recognizable \
                 SHA-256 digest — this looks like a publishing problem upstream; use --hub-dir to \
                 point at a local Hub checkout instead"
            )
        })?;

        use sha2::{Digest, Sha256};
        let actual_digest = format!("{:x}", Sha256::digest(&archive_bytes));
        if actual_digest != expected_digest {
            return Err(format!(
                "downloaded Hub archive for v{version} does not match its published checksum \
                 (expected {expected_digest}, got {actual_digest}) — the download may have been \
                 corrupted or tampered with; retrying the fetch, or using --hub-dir to point at a \
                 local Hub checkout instead, are both safe next steps"
            ));
        }

        write_atomically(&archive_path, &archive_bytes)?;
        write_atomically(&checksum_path, expected_digest.as_bytes())?;
    }

    // Always re-derive `extracted/` fresh from the now-verified archive, regardless of whether this
    // was a cache hit or a fresh fetch — never trust pre-existing extracted content, which is
    // exactly the historical poisoning vector (a file planted directly under the extraction
    // directory bypasses the archive's checksum entirely).
    let extracted_dir = version_dir.join("extracted");
    if extracted_dir.is_dir() {
        fs::remove_dir_all(&extracted_dir).map_err(|e| {
            format!(
                "could not clear the stale extracted Hub directory {} before re-extracting ({e}) \
                 — check that the location is writable, or use --hub-dir to point at a local Hub \
                 checkout instead",
                extracted_dir.display()
            )
        })?;
    }
    let extracting_dir = version_dir.join(format!(".extracted.tmp-{}", std::process::id()));
    if extracting_dir.exists() {
        let _ = fs::remove_dir_all(&extracting_dir);
    }
    fs::create_dir_all(&extracting_dir).map_err(|e| {
        format!(
            "could not create {} to extract the Hub archive into ({e}) — check that the location \
             is writable, or use --hub-dir to point at a local Hub checkout instead",
            extracting_dir.display()
        )
    })?;
    let archive_bytes = fs::read(&archive_path).map_err(|e| {
        format!(
            "could not read the cached Hub archive {} ({e}) — try removing {} and re-running, or \
             use --hub-dir to point at a local Hub checkout instead",
            archive_path.display(),
            version_dir.display()
        )
    })?;
    let decoder = flate2::read::GzDecoder::new(archive_bytes.as_slice());
    let mut archive = tar::Archive::new(decoder);
    archive.unpack(&extracting_dir).map_err(|e| {
        format!(
            "the cached Hub archive for v{version} could not be extracted ({e}) — it may be \
             corrupted; try removing {} and re-running, or use --hub-dir to point at a local Hub \
             checkout instead",
            version_dir.display()
        )
    })?;
    fs::rename(&extracting_dir, &extracted_dir).map_err(|e| {
        format!(
            "could not finalize the extracted Hub directory {} ({e}) — check that the location is \
             writable, or use --hub-dir to point at a local Hub checkout instead",
            extracted_dir.display()
        )
    })?;

    Ok(extracted_dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_hub_version_accepts_a_plain_triplet() {
        assert!(validate_hub_version("0.7.0").is_ok());
        assert!(validate_hub_version("12.34.56").is_ok());
    }

    #[test]
    fn validate_hub_version_accepts_prerelease_and_build_suffixes() {
        assert!(validate_hub_version("0.7.0-rc.1").is_ok());
        assert!(validate_hub_version("0.7.0+build.5").is_ok());
    }

    #[test]
    fn validate_hub_version_rejects_mutable_refs() {
        for bad in ["main", "latest", "HEAD", ""] {
            let err = validate_hub_version(bad).expect_err(bad);
            assert!(err.contains("not a valid Hub version"), "{bad}: {err}");
            assert!(err.contains("--hub-dir"), "{bad}: {err}");
        }
    }

    #[test]
    fn validate_hub_version_rejects_partial_versions() {
        assert!(validate_hub_version("0.7").is_err());
        assert!(validate_hub_version("0.7.0.1").is_err());
        assert!(validate_hub_version("v0.7.0").is_err());
    }

    #[test]
    fn parse_checksum_sidecar_accepts_sha256sum_format() {
        let digest = "a".repeat(64);
        let sidecar = format!("{digest}  hub-0.7.0.tar.gz\n");
        assert_eq!(parse_checksum_sidecar(&sidecar), Some(digest));
    }

    #[test]
    fn parse_checksum_sidecar_accepts_bare_digest() {
        let digest = "b".repeat(64);
        assert_eq!(parse_checksum_sidecar(&digest), Some(digest));
    }

    #[test]
    fn parse_checksum_sidecar_rejects_garbage() {
        assert_eq!(parse_checksum_sidecar("not a checksum"), None);
        assert_eq!(parse_checksum_sidecar(""), None);
    }

    #[test]
    fn archive_urls_match_the_release_asset_contract() {
        // SAFETY: single-threaded test body; no other test in this process reads this var
        // concurrently with a mismatched expectation (each caller sets and immediately reads it).
        unsafe {
            std::env::set_var(BASE_URL_ENV, "https://example.test/dl");
        }
        let (archive, checksum) = archive_urls("0.7.0");
        unsafe {
            std::env::remove_var(BASE_URL_ENV);
        }
        assert_eq!(archive, "https://example.test/dl/v0.7.0/hub-0.7.0.tar.gz");
        assert_eq!(
            checksum,
            "https://example.test/dl/v0.7.0/hub-0.7.0.tar.gz.sha256"
        );
    }
}
