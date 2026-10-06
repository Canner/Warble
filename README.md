# Warble

**Warble helps you author and reuse an agent's harness:** its instructions, behaviors, tool
requirements, and constraints. Keep those choices in a reviewable **profile**, compose reusable
**components**, and emit the native artifacts for a supported runtime. Data agents are the main
use case; the first tutorial simply summarizes text supplied by the user.

```
profile + components + optional context  ──►  warble compile  ──►  IR  ──►  warble dispatch  ──►  native agent
```

Your prompts are authored assets. The compiler's **IR** is the intermediate contract that lets
back-ends reuse them; understanding its schema is not a prerequisite for writing a harness.
Portability covers each target's supported semantics, not identical model behavior.

For CLI file targets, Warble checks requirements and writes native instructions and settings;
the coding agent owns the conversation and agent loop. Prompt instructions such as "retry three
times" do not by themselves enforce a counter. Unsupported safety-critical or unknown capabilities fail before
executable artifacts are emitted; explicitly supported best-effort degradation is reported. Warble does not add a general workflow runner for arbitrary
loops, branches or checkpoints. Existing SDK/local integrations retain their bounded contracts.
See [settings and guarantees](./docs/spec/authoring.md#what-an-authored-setting-guarantees).

New here? Read the [introduction](./docs/site/docs/getting-started/introduction.md). The
authoritative contract lives in [`docs/spec/`](./docs/spec/authoring.md).

## Developer preview

Warble is pre-1.0 (`0.x`), and **any `0.x` bump may BREAK any public API, CLI flag, or file
format**. See [RELEASING.md](./RELEASING.md) for the pre-1.0 policy and
[CHANGELOG.md](./CHANGELOG.md) for what has already changed.

The local Codex dispatcher now requires explicit `--transport exec|turn|orchestrate` and
caller-owned `--step-tool` / `--require-tool` bindings, without legacy flag aliases.
See its [transport and isolation contract](./dispatcher/codex-local/README.md).

## Install

### From a release

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/Canner/Warble/releases/latest/download/warble-cli-installer.sh | sh
```

Installs the `warble` binary into `~/.cargo/bin` — no Rust toolchain needed. macOS and Linux only;
there are no Windows or `musl` builds. If you already have Rust, `cargo install warble-cli --locked`
works as well. Prebuilt tarballs and checksum verification are covered in
[Installation](./docs/site/docs/getting-started/installation.md).

### From source

```bash
git clone https://github.com/Canner/Warble.git
cd Warble
just release
export PATH="$PWD/target/release:$PATH"
```

`just release` is a thin wrapper around `cargo build --release --locked -p warble-cli`.

## Run

Start with a local text-summary harness. From a source checkout, compile and emit its native files:

```bash
warble check examples/first-harness --target claude-code:headless
warble preview examples/first-harness --target claude-code:headless
warble build examples/first-harness --target claude-code:headless --out agent
```

`check`, `preview` and `build` manage the intermediate IR for authors. Preview shows exact native
instructions, author sources and generated permissions; build requires a new output directory.
The lower-level `compile` and `dispatch` commands remain available for backend/host integrations.

This one-file profile needs no context binding. Inline-only and locally resolved projects compile
offline without fetching the Hub, and these commands do not run a model. Read `agent/RUN.md`
before starting the native agent; this example needs Claude Code but no database or `wren` CLI.
IR 0.9 represents absent context explicitly. Upgrade readers together and recompile old 0.8 IR.
The [Quickstart](./docs/site/docs/getting-started/quickstart.md) walks through the files and optional run,
and the [CLI reference](./docs/site/docs/reference/cli.md) covers the other commands (`render`,
`manifest`, `eval`, `blast-radius`, `mcp-serve`).

## Documentation

- [Getting started](./docs/site/docs/getting-started/introduction.md) — introduction, installation, quickstart, your first profile
- [Concepts](./docs/site/docs/concepts/how-warble-works.md) — how Warble works, profiles, components, capabilities, blast radius
- [Specs](./docs/spec/authoring.md) — the authoritative contract: authoring, IR schema, capability model, binding
- [Roadmap](./docs/roadmap.md) — what is built, what is deferred, and what each behavior tier unlocks

## Contributing

[CONTRIBUTING.md](./CONTRIBUTING.md) has the project layout, the build and test flows, and the
design rules a change has to fit. Bugs and feature requests go to GitHub Issues.

## Development

`just build`, `just test`, `just lint`, and `just doc` cover the Rust workspace, and the two
TypeScript back-ends have their own recipes (`just --list`); the docs site builds with plain `npm`
scripts. Pointing a coding agent at Warble? See
[AI resources](./docs/site/static/llms.txt).

## License

[Apache-2.0](./LICENSE).
