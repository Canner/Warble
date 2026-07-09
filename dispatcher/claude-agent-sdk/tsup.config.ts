import { defineConfig } from "tsup";

// Build the embeddable library (index) + the CLI (cli, with its node shebang) to dist/ as ESM,
// emitting .d.ts so consumers get types. The Agent SDK stays external (peer at runtime).
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node18",
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["@anthropic-ai/claude-agent-sdk", "yaml"],
});
