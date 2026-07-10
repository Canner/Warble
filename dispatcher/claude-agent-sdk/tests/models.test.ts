import { test } from "node:test";
import assert from "node:assert/strict";

// §9.2 layer-3 binding format (provider/endpoint/model) — TS sibling of the Rust models_tests.rs.
import { ModelConfig } from "../src/models.js";
import { DispatchError } from "../src/error.js";

test("shorthand string tier is an anthropic binding; require() returns the model", () => {
  const m = ModelConfig.fromYaml("tiers:\n  strong: opus\n");
  const b = m.binding("strong");
  assert.equal(b.provider, "anthropic");
  assert.equal(b.endpoint, null);
  assert.equal(b.model, "opus");
  assert.equal(m.require("strong"), "opus");
});

test("structured tier binds provider/endpoint/model; require() still returns just the model", () => {
  const m = ModelConfig.fromYaml(
    "tiers:\n  strong: opus\n  cheap:\n    provider: openai_compat\n    endpoint: http://localhost:11434/v1\n    model: qwen2.5\n",
  );
  assert.equal(m.binding("strong").provider, "anthropic");
  const cheap = m.binding("cheap");
  assert.equal(cheap.provider, "openai_compat");
  assert.equal(cheap.endpoint, "http://localhost:11434/v1");
  assert.equal(cheap.model, "qwen2.5");
  assert.equal(m.require("cheap"), "qwen2.5");
});

test("default() and fromFlags() are anthropic-provider bindings", () => {
  assert.equal(ModelConfig.default().binding("strong").provider, "anthropic");
  assert.equal(ModelConfig.fromFlags("opus", "haiku", "sonnet").binding("cheap").provider, "anthropic");
});

test("openai_compat without endpoint loud-fails", () => {
  assert.throws(
    () => ModelConfig.fromYaml("tiers:\n  cheap:\n    provider: openai_compat\n    model: qwen2.5\n"),
    (e: unknown) => e instanceof DispatchError && /endpoint/.test((e as Error).message),
  );
});

test("structured tier without model loud-fails", () => {
  assert.throws(
    () => ModelConfig.fromYaml("tiers:\n  cheap:\n    provider: anthropic\n"),
    (e: unknown) => e instanceof DispatchError && /model/.test((e as Error).message),
  );
});

test("unknown provider loud-fails naming the accepted providers", () => {
  assert.throws(
    () => ModelConfig.fromYaml("tiers:\n  cheap:\n    provider: bedrock\n    endpoint: http://x/v1\n    model: m\n"),
    (e: unknown) => e instanceof DispatchError && /bedrock/.test((e as Error).message) && /openai_compat/.test((e as Error).message),
  );
});
