//! Integration tests for the Hub network fetch/cache path (`hub_fetch::ensure_cached_hub` and
//! `default_component_sources_with_hub_version`), run against a hand-rolled local HTTP fixture
//! server so the suite stays fully offline. No test here ever contacts a real GitHub Release.
//!
//! `WARBLE_HUB_BASE_URL` and `WARBLE_HUB_CACHE_ROOT` are process-wide environment variables, so
//! every test that touches them takes `ENV_LOCK` first to serialize against the other tests in
//! this binary (integration test files are separate processes, but `#[test]`s within one file run
//! on parallel threads by default).

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use warble_cli::hub_fetch::ensure_cached_hub;
use warble_cli::{
    compile_project_to_ir_with_sources, default_component_sources_with_hub_version, ComponentSource,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

// --- fixture HTTP server ----------------------------------------------------------------------

/// A minimal single-purpose HTTP/1.1 server: maps an exact request path to a canned
/// `(status, body)` response, or 404s anything unmapped. Runs on a background thread for the
/// life of the test process; there is no shutdown, which is fine for a short-lived test binary.
struct FixtureServer {
    base_url: String,
    request_count: Arc<AtomicUsize>,
}

impl FixtureServer {
    fn start(routes: HashMap<String, (u16, Vec<u8>)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind an ephemeral local port");
        let addr = listener.local_addr().unwrap();
        let request_count = Arc::new(AtomicUsize::new(0));
        let routes = Arc::new(routes);
        {
            let request_count = Arc::clone(&request_count);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { continue };
                    request_count.fetch_add(1, Ordering::SeqCst);
                    let mut buf = [0u8; 8192];
                    let n = match stream.read(&mut buf) {
                        Ok(n) => n,
                        Err(_) => continue,
                    };
                    let request = String::from_utf8_lossy(&buf[..n]);
                    let path = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1))
                        .unwrap_or("/")
                        .to_string();
                    let (status, body) = routes
                        .get(&path)
                        .cloned()
                        .unwrap_or((404, b"not found".to_vec()));
                    let reason = if status == 200 { "OK" } else { "Not Found" };
                    let header = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(header.as_bytes());
                    let _ = stream.write_all(&body);
                    let _ = stream.flush();
                }
            });
        }
        FixtureServer {
            base_url: format!("http://{addr}"),
            request_count,
        }
    }

    fn base_url(&self) -> String {
        self.base_url.clone()
    }

    fn request_count(&self) -> usize {
        self.request_count.load(Ordering::SeqCst)
    }
}

// --- archive fixtures -------------------------------------------------------------------------

fn component_yaml(component_id: &str) -> String {
    format!(
        r#"
id: {component_id}
verb: {component_id}
type: analytical
realization_kind: skill
binding_mode: runtime_selected
context_precondition: []
params: []
llm_steps:
  - {{ name: ask, tier: cheap, prompt_ref: steps/ask.md }}
trigger: {{ kind: one_shot }}
guardrails:
  - {{ name: read_only_execution, locked: true }}
required_capabilities: [llm:cheap]
borrowed_actions: []
effect:
  render_blocks: []
  outcome:
    kind: none
"#
    )
}

/// Builds a valid `hub-<version>.tar.gz` archive containing one component directory at the
/// archive root (matching the release-asset layout contract: `<component_id>/component.yml`, no
/// `components/` prefix). Returns the gzip bytes and their lowercase hex SHA-256 digest.
fn build_component_archive(component_id: &str) -> (Vec<u8>, String) {
    let src = tempfile::tempdir().unwrap();
    fs::create_dir_all(src.path().join("steps")).unwrap();
    fs::write(
        src.path().join("component.yml"),
        component_yaml(component_id),
    )
    .unwrap();
    fs::write(src.path().join("steps/ask.md"), "Ask something.\n").unwrap();

    let mut tar_bytes = Vec::new();
    {
        let mut builder = tar::Builder::new(&mut tar_bytes);
        builder
            .append_dir_all(component_id, src.path())
            .expect("archive the fixture component directory");
        builder.finish().unwrap();
    }
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(&tar_bytes).unwrap();
    let gz_bytes = encoder.finish().unwrap();
    let digest = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(&gz_bytes))
    };
    (gz_bytes, digest)
}

fn routes_for(version: &str, archive: &[u8], sidecar: &str) -> HashMap<String, (u16, Vec<u8>)> {
    let mut routes = HashMap::new();
    routes.insert(
        format!("/v{version}/hub-{version}.tar.gz"),
        (200, archive.to_vec()),
    );
    routes.insert(
        format!("/v{version}/hub-{version}.tar.gz.sha256"),
        (200, sidecar.as_bytes().to_vec()),
    );
    routes
}

/// A one-component Warble project mounting `component_id`, with an `external` context binding so
/// compiling it needs no filesystem/network beyond resolving the component itself.
fn write_project_mounting(dir: &Path, component_id: &str) {
    fs::create_dir_all(dir.join("context")).unwrap();
    fs::write(
        dir.join("profile.yml"),
        format!("profile: fixture\ncontext:\n  project: ./context/binding.yml\ncomponents:\n  - use: {component_id}\n"),
    )
    .unwrap();
    fs::write(
        dir.join("context/binding.yml"),
        "kind: external\nproject: remote-service://analytics\n",
    )
    .unwrap();
}

// --- AC1: fetch resolves a Hub component from a binary with no in-repo hub --------------------

#[test]
fn fetch_resolves_a_hub_mounted_component_and_it_compiles() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.1";
    let (archive, digest) = build_component_archive("probe_fetch");
    let sidecar = format!("{digest} *hub-{version}.tar.gz\n");
    let server = FixtureServer::start(routes_for(version, &archive, &sidecar));
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let result = ensure_cached_hub(version);
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }
    let extracted =
        result.expect("fetch + checksum verify + extract must succeed against the fixture server");
    assert_eq!(
        server.request_count(),
        2,
        "a cold cache must fetch exactly the archive and its checksum sidecar"
    );

    let project = tempfile::tempdir().unwrap();
    write_project_mounting(project.path(), "probe_fetch");
    let sources = vec![
        ComponentSource::local(project.path().join("components")),
        ComponentSource::hub(extracted),
    ];
    let ir = compile_project_to_ir_with_sources(project.path(), &sources)
        .expect("a profile mounting a Hub component fetched over the network must compile");
    assert_eq!(ir["components"][0]["id"], "probe_fetch");
}

// --- AC2: an in-repo hub/components wins outright, no request ever reaches the server ----------

#[test]
fn in_repo_hub_is_preferred_and_no_request_reaches_the_server() {
    let _guard = ENV_LOCK.lock().unwrap();
    // No routes at all: any request that reached this server would 404, but the assertion below
    // is on request_count, so even an accidental 404 would be caught as a failure.
    let server = FixtureServer::start(HashMap::new());
    let project = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
    }
    let result = default_component_sources_with_hub_version(project.path(), None);
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
    }

    result.expect("this checkout's in-repo hub/components must resolve without the network");
    assert_eq!(
        server.request_count(),
        0,
        "no HTTP request may reach the fixture server when hub/components exists in-repo"
    );
}

// --- AC3: cache trust — corruption is not silently reused, extracted/ is always rebuilt --------

#[test]
fn a_mismatched_cache_entry_is_treated_as_a_miss_and_refetched() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.2";
    let (archive, digest) = build_component_archive("probe_a");
    let sidecar = format!("{digest} *hub-{version}.tar.gz\n");
    let server = FixtureServer::start(routes_for(version, &archive, &sidecar));
    let cache_root = tempfile::tempdir().unwrap();

    let version_dir = cache_root.path().join("warble").join("hub").join(version);
    fs::create_dir_all(&version_dir).unwrap();
    // Plant a garbage archive alongside a sidecar that does not match it — a stale/foreign or
    // corrupted cache entry, self-inconsistent by construction.
    fs::write(
        version_dir.join(format!("hub-{version}.tar.gz")),
        b"not a real archive",
    )
    .unwrap();
    fs::write(
        version_dir.join(format!("hub-{version}.tar.gz.sha256")),
        format!("{} *hub-{version}.tar.gz\n", "0".repeat(64)),
    )
    .unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let result = ensure_cached_hub(version);
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    let extracted = result.expect(
        "a self-inconsistent cache entry must be treated as a miss and refetched, not surfaced as an error",
    );
    assert!(
        extracted.join("probe_a").join("component.yml").is_file(),
        "the freshly-fetched, verified archive must be what gets extracted"
    );
    let on_disk = fs::read(version_dir.join(format!("hub-{version}.tar.gz"))).unwrap();
    assert_eq!(
        on_disk, archive,
        "the garbage archive must be overwritten by the verified fetch, not left in place"
    );
    assert_eq!(
        server.request_count(),
        2,
        "a cache miss must fetch both the archive and its checksum"
    );
}

#[test]
fn extracted_dir_is_rebuilt_from_the_verified_archive_even_on_a_cache_hit() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.3";
    let (archive, digest) = build_component_archive("probe_b");
    let sidecar = format!("{digest} *hub-{version}.tar.gz\n");
    let server = FixtureServer::start(routes_for(version, &archive, &sidecar));
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let first = ensure_cached_hub(version).expect("first fetch should succeed");
    assert_eq!(
        server.request_count(),
        2,
        "first call is a cold-cache fetch"
    );

    // Directly plant a canary file under extracted/, bypassing the archive/checksum entirely --
    // reproducing the historical poisoning vector this module's cache-trust design closes: a
    // canary surviving inside a cached step file and reappearing in emitted IR.
    fs::write(
        first.join("probe_b").join("component.yml"),
        "id: poisoned-canary\n",
    )
    .unwrap();

    let second = ensure_cached_hub(version).expect("second call (cache hit) should still succeed");
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    assert_eq!(
        second, first,
        "the same version must resolve to the same extracted path"
    );
    let content = fs::read_to_string(second.join("probe_b").join("component.yml")).unwrap();
    assert!(
        !content.contains("poisoned-canary"),
        "a directly-planted file under extracted/ must not survive a later call, even a cache hit: {content}"
    );
    assert_eq!(
        server.request_count(),
        2,
        "a genuine cache hit (archive matches its sidecar) must not re-fetch over the network"
    );
}

#[cfg(unix)]
#[test]
fn the_per_version_cache_directory_is_owner_only() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.4";
    let (archive, digest) = build_component_archive("probe_c");
    let sidecar = format!("{digest} *hub-{version}.tar.gz\n");
    let server = FixtureServer::start(routes_for(version, &archive, &sidecar));
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    ensure_cached_hub(version).expect("fetch should succeed");
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    use std::os::unix::fs::PermissionsExt;
    let version_dir = cache_root.path().join("warble").join("hub").join(version);
    let mode = fs::metadata(&version_dir).unwrap().permissions().mode() & 0o777;
    assert_eq!(
        mode, 0o700,
        "the per-version Hub cache directory must be owner-only, never group- or world-writable"
    );
}

// --- AC4: every failure path names what the user can do about it -------------------------------

#[test]
fn a_missing_release_asset_names_http_404_and_the_hub_dir_escape_hatch() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.5";
    let server = FixtureServer::start(HashMap::new()); // everything 404s
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let err = ensure_cached_hub(version).unwrap_err();
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    assert!(err.contains("404"), "expected the 404 to be named: {err}");
    assert!(
        err.contains("--hub-dir"),
        "expected the escape hatch to be named: {err}"
    );
}

#[test]
fn an_unreachable_host_names_the_network_problem_and_the_escape_hatch() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.6";
    // Bind then immediately drop: the OS will refuse connections to this port deterministically,
    // with no real server ever listening -- a fast, hang-free "unreachable host".
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let dead_addr = listener.local_addr().unwrap();
    drop(listener);
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", format!("http://{dead_addr}"));
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let err = ensure_cached_hub(version).unwrap_err();
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    assert!(
        err.contains("--hub-dir"),
        "expected the escape hatch to be named: {err}"
    );
}

#[test]
fn a_checksum_mismatch_names_the_problem_and_the_escape_hatch() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.7";
    let (archive, _digest) = build_component_archive("probe_d");
    let wrong_sidecar = format!("{} *hub-{version}.tar.gz\n", "f".repeat(64));
    let server = FixtureServer::start(routes_for(version, &archive, &wrong_sidecar));
    let cache_root = tempfile::tempdir().unwrap();

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", server.base_url());
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let err = ensure_cached_hub(version).unwrap_err();
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    assert!(
        err.contains("checksum"),
        "expected the checksum problem to be named: {err}"
    );
    assert!(
        err.contains("--hub-dir"),
        "expected the escape hatch to be named: {err}"
    );
}

#[cfg(unix)]
#[test]
fn an_unwritable_cache_root_names_the_permission_problem_and_the_escape_hatches() {
    let _guard = ENV_LOCK.lock().unwrap();
    let version = "9.9.8";
    let cache_root = tempfile::tempdir().unwrap();

    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(cache_root.path(), fs::Permissions::from_mode(0o500)).unwrap();

    // Skip (rather than false-fail) if this process can write despite the restrictive mode --
    // e.g. running as root in some CI containers, where permission bits are not enforced.
    let probe = cache_root.path().join("probe-write-access");
    let can_bypass = fs::create_dir(&probe).is_ok();
    if can_bypass {
        let _ = fs::remove_dir(&probe);
        fs::set_permissions(cache_root.path(), fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!(
            "skipping an_unwritable_cache_root_names_the_permission_problem_and_the_escape_hatches: \
             this process can write through 0o500 (likely running as root)"
        );
        return;
    }

    unsafe {
        std::env::set_var("WARBLE_HUB_BASE_URL", "http://127.0.0.1:1");
        std::env::set_var("WARBLE_HUB_CACHE_ROOT", cache_root.path());
    }
    let err = ensure_cached_hub(version).unwrap_err();
    unsafe {
        std::env::remove_var("WARBLE_HUB_BASE_URL");
        std::env::remove_var("WARBLE_HUB_CACHE_ROOT");
    }

    fs::set_permissions(cache_root.path(), fs::Permissions::from_mode(0o700)).unwrap();

    assert!(
        err.contains("cache"),
        "expected the cache-directory problem to be named: {err}"
    );
    assert!(
        err.contains("--hub-dir"),
        "expected the escape hatch to be named: {err}"
    );
}
