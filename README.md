# Warble

**Warble is a data behavior framework.** You declare *what a data agent should do* — components,
guardrails, and config, bound to a semantic context — as a git-diffable **profile**. Warble's
front-end compiles that profile into a language-neutral **IR**, and a thin, replaceable back-end
turns the IR into a native agent for one runtime.

```
profile + components + context  ──►  warble compile  ──►  IR  ──►  warble dispatch  ──►  native agent
```

The contract — profile schema, capability manifest, IR — is the product; prompts, agent config,
and each runtime's back-end are derived or commodity. Today's back-ends emit agents for the Claude
Code CLI, a native Codex session, the Claude Agent SDK, and a serverless bundle.

New here? Read the [introduction](./docs/site/docs/getting-started/introduction.md). The
authoritative contract lives in [`docs/spec/`](./docs/spec/authoring.md).

## Developer preview

Warble is pre-1.0 (`0.x`), and **any `0.x` bump may BREAK any public API, CLI flag, or file
format**. See [RELEASING.md](./RELEASING.md) for the pre-1.0 policy and
[CHANGELOG.md](./CHANGELOG.md) for what has already changed.

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

Compile a bundled example profile to IR, then dispatch that IR to a target:

```bash
warble compile examples/render-demo -o ir.json
warble dispatch ir.json --target claude-code:headless --out agent
```

`compile` is the front-end (parse → merge defaults with overrides → validate → emit IR);
`dispatch` is the back-end (legalize the IR onto one runtime → write its native agent files).

Running the emitted agent is a separate step: it needs the `wren` CLI on a queryable wren project,
as the generated `agent/RUN.md` spells out. The
[Quickstart](./docs/site/docs/getting-started/quickstart.md) walks the whole pipeline end to end,
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
