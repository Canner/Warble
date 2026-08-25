import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/prepare-cli.ts", "src/report-cli.ts", "src/smoke-cli.ts"],
  format: ["esm"],
  // Each bin must stay a single self-contained file: the direct-execution guard compares
  // import.meta.url with process.argv[1], and a shared chunk would never match, silently
  // turning every CLI into a no-op.
  splitting: false,
  dts: true,
  sourcemap: true,
  clean: true,
});
