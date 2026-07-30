---
title: Installation
description: "Install the released `warble` binary via the shell installer, a prebuilt tarball, or `cargo install warble-cli` — or build from source."
---

Warble is released as one native Rust binary, `warble`, installed from the crate
**`warble-cli`** (the crate and the binary it installs are named differently — keep that straight
when you're looking for either one).

## Choose an install path

| Path | Needs | Best for |
| --- | --- | --- |
| [Shell installer](#shell-installer) | nothing (no Rust toolchain) | most people |
| [Prebuilt tarball](#prebuilt-tarball) | nothing | placing the binary yourself, or verifying checksums |
| [`cargo install`](#cargo-install) | Rust (cargo) | anyone who already has Rust |
| [Build from source](#build-from-source) | Rust (cargo) | contributors, and platforms with no prebuilt binary |

### Supported platforms

Prebuilt binaries (the shell installer, the tarballs, and `cargo install`'s underlying release
artifacts) are available for:

- **macOS** — `aarch64` (Apple Silicon) and `x86_64` (Intel)
- **Linux** — `x86_64` and `aarch64`, glibc only

**There are no Windows builds** — Windows is not supported, not merely unbuilt (see
[`CHANGELOG.md`](https://github.com/Canner/Warble/blob/main/CHANGELOG.md#known-limitations) for
why). **There are no static `musl` builds** either. On any other platform, [build from
source](#build-from-source).

## Shell installer

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Canner/Warble/releases/download/v0.1.0/warble-cli-installer.sh | sh
```

Detects your platform, downloads the matching release tarball, and installs `warble` to
`$CARGO_HOME/bin` (`~/.cargo/bin` by default) — no `sudo`, no Rust toolchain needed. Make sure
that directory is on your `PATH`.

For an always-latest install instead of pinning to `v0.1.0`, use
`https://github.com/Canner/Warble/releases/latest/download/warble-cli-installer.sh`.

## Prebuilt tarball

Download the archive for your platform from the
[`v0.1.0` release](https://github.com/Canner/Warble/releases/tag/v0.1.0):

- macOS (Apple Silicon): `warble-cli-aarch64-apple-darwin.tar.xz`
- macOS (Intel): `warble-cli-x86_64-apple-darwin.tar.xz`
- Linux (arm64, glibc): `warble-cli-aarch64-unknown-linux-gnu.tar.xz`
- Linux (x86_64, glibc): `warble-cli-x86_64-unknown-linux-gnu.tar.xz`

Each archive has a matching `.sha256` file, and the release also publishes one `sha256.sum`
covering everything. Verify, extract, and put the `warble` binary anywhere on your `PATH`:

```bash
shasum -a 256 -c warble-cli-aarch64-apple-darwin.tar.xz.sha256
tar -xf warble-cli-aarch64-apple-darwin.tar.xz
install -m 755 warble-cli-*/warble ~/.local/bin/warble   # or any dir on your PATH
```

## `cargo install`

If you already have Rust:

```bash
cargo install warble-cli --locked
```

This builds `warble-cli` from the published crate (not from a prebuilt binary) and installs the
`warble` binary to `~/.cargo/bin`. `--locked` uses the crate's committed lockfile; drop it only if
that fails.

## Build from source

For contributors, or a platform with no prebuilt binary above.

**1. Clone the repository**

```bash
git clone https://github.com/Canner/Warble.git
cd Warble
```

**2. Build the release binary**

```bash
just release
```

This runs `cargo build --release -p warble-cli` and produces the binary at
`target/release/warble`. No `just`? Run the `cargo build` command directly — `just` is a thin
wrapper around it.

**3. Put it on your PATH**

```bash
export PATH="$PWD/target/release:$PATH"
```

Or symlink/copy `target/release/warble` somewhere already on your `PATH`.

### Optional: the wider workspace

The steps above are all you need to use `warble`. If you're going to work on Warble itself — the
compiler, a back-end, or the eval comparator — the workspace has a few more `just` recipes:

- `just build` / `just test` / `just lint` — the whole Rust workspace (compiler, `claude-code-cli`
  back-end, eval comparator, CLI).
- `just install-ts` / `just lint-ts` / `just test-ts` — the `claude-agent-sdk` TS back-end, which is
  a separate npm package and needs Node.

## Verify

Whichever path you used:

```bash
warble --version
```

```text
warble 0.1.0
```

```bash
warble --help
```

If both print, the install is good.

## Running an emitted agent

Installing `warble` is enough to compile profiles and dispatch agent files. Actually *running* an
emitted agent is a separate step: it needs the `wren` CLI on a queryable wren project, as spelled
out in the `RUN.md` that `warble dispatch` generates alongside the agent files. The Quickstart
walks through that end to end.

- **[Quickstart](/getting-started/quickstart)** — Compile and dispatch an example agent end-to-end in ~5 minutes.
- **[Your first profile](/getting-started/first-profile)** — Author the smallest possible profile from scratch.
