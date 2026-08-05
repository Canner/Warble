import assert from "node:assert/strict";
import { test } from "node:test";

import { discoverClaudeModels, type DiscoverClaudeModelsOptions } from "../src/model_catalog.js";

function fakeQuery(behavior: () => Promise<unknown>) {
  const iterator = (async function* (): AsyncGenerator<never, void> {})();
  let interrupts = 0;
  let returns = 0;
  const originalReturn = iterator.return.bind(iterator);
  Object.assign(iterator, {
    supportedModels: behavior,
    interrupt: async () => {
      interrupts += 1;
    },
    return: async () => {
      returns += 1;
      return originalReturn();
    },
  });
  return {
    query: iterator as never,
    cleanup: () => ({ interrupts, returns }),
  };
}

test("Claude catalog uses an empty input with no tools/MCP/settings and cleans up its idle query", async () => {
  let observed: Parameters<Exclude<DiscoverClaudeModelsOptions["queryFactory"], undefined>>[0] | undefined;
  let inputItems = 0;
  const fake = fakeQuery(async () => [
    { value: "sonnet", displayName: "Claude Sonnet", description: "Balanced" },
  ]);
  const result = await discoverClaudeModels({
    cwd: "/tmp",
    queryFactory: (params) => {
      observed = params;
      return fake.query;
    },
  });
  for await (const _item of observed!.prompt) inputItems += 1;

  assert.deepEqual(result, {
    version: 1,
    status: "ready",
    provider: "claude",
    models: [{ model: "sonnet", displayName: "Claude Sonnet", description: "Balanced" }],
  });
  assert.equal(inputItems, 0, "discovery must not yield a user prompt");
  assert.deepEqual(observed!.options.tools, []);
  assert.deepEqual(observed!.options.mcpServers, []);
  assert.deepEqual(observed!.options.settingSources, []);
  assert.deepEqual(fake.cleanup(), { interrupts: 1, returns: 1 });
});

test("Claude catalog returns a redacted unavailable result for auth failures", async () => {
  const fake = fakeQuery(async () => {
    throw new Error("not authenticated: raw-token-must-not-leak");
  });
  const result = await discoverClaudeModels({ queryFactory: () => fake.query });
  assert.deepEqual(result, {
    version: 1,
    status: "unavailable",
    provider: "claude",
    code: "not_authenticated",
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /raw-token-must-not-leak/);
  assert.deepEqual(fake.cleanup(), { interrupts: 1, returns: 1 });
});

test("Claude catalog bounds a hanging SDK request and cleans up", async () => {
  const fake = fakeQuery(async () => new Promise<never>(() => undefined));
  const result = await discoverClaudeModels({ timeoutMs: 5, queryFactory: () => fake.query });
  assert.deepEqual(result, {
    version: 1,
    status: "unavailable",
    provider: "claude",
    code: "timeout",
    retryable: true,
  });
  assert.deepEqual(fake.cleanup(), { interrupts: 1, returns: 1 });
});

test("Claude catalog rejects malformed SDK model data without reflecting it", async () => {
  const fake = fakeQuery(async () => [{ value: "sonnet", displayName: 123, secret: "must-not-leak" }]);
  const result = await discoverClaudeModels({ queryFactory: () => fake.query });
  assert.deepEqual(result, {
    version: 1,
    status: "unavailable",
    provider: "claude",
    code: "protocol_error",
    retryable: false,
  });
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak/);
});
