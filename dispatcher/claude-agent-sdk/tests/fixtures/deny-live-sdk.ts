import { mock } from "node:test";

// Subprocess regression tripwire: never import or execute the vendor implementation.
mock.module("@anthropic-ai/claude-agent-sdk", {
  namedExports: { query() { throw new Error("UNEXPECTED_LIVE_QUERY"); } },
});
