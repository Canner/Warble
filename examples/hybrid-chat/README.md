# Standalone hybrid chat fixture

This synthetic profile demonstrates the separate `pi:hybrid` target. It has one public
planning step and the compiled `answer` alias to a private single-step leaf. It does not
load Wren, GenBI, a database, or stock pi InteractiveMode. The adapter exposes synthetic
metadata and validates a bounded `{count}` answer; it is not a production data verifier.

From the repository root:

```sh
just install-pi-ts build-pi-ts
cargo build -p warble-cli
node examples/hybrid-chat/prepare.mjs --out /tmp/hybrid-runtime.json
```

The last command creates a template with explicit adapter digest, blind/schema/business
selections and placeholder model IDs. It does not start providers. Replace model IDs and
endpoints with an explicitly approved, tested configuration; named credential environment
variables must be supplied before launching. No pi/Codex/Claude subscription login is read.
The template's blanket Cedar permit is for synthetic data only; narrow deployment policy
before using a real adapter.

```sh
target/debug/warble compile examples/hybrid-chat --out /tmp/hybrid-ir.json
target/debug/warble dispatch /tmp/hybrid-ir.json --target pi:hybrid \
  --hybrid-config /tmp/hybrid-runtime.json --out /tmp/hybrid-session
node dispatcher/pi/dist/cli.js launch /tmp/hybrid-session
```

The output directory must not exist. The launcher is interactive and accepts only `launch
<directory>` (or `--help`). `/help` lists configured choices. `/policy schema`, `/model claude`,
`/project demo` and `/reset` cancel old work and start empty epochs. `/quit` or Ctrl-C closes
the runtime. There is no resume, compaction, import/export, shell or ambient discovery.
Already-sent data cannot be recalled; old terminal scrollback is not erased.

For an entirely offline-provider verification, with no real credentials or paid calls:

```sh
WARBLE_BIN="$PWD/target/debug/warble" just test-pi-ts
```

The tests start ephemeral loopback OpenAI/Anthropic fixtures and drive the generated launch
artifact in a real PTY, including follow-up, command refusal and epoch reset. They stop all
owned servers/processes and remove temporary launch directories afterward.
