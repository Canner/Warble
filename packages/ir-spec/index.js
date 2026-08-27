/**
 * The Warble IR version this package's own npm version encodes.
 *
 * This package is not meant to be imported by a dispatcher — see `docs/spec/ir-schema.md` (bundled
 * here as `ir-schema.md`) for why: a dispatcher keeps its own independently declared
 * `SUPPORTED_IR_VERSION`(S) constant instead, so this package's role is to exist as a resolvable
 * npm node whose *version* is the contract, not to be depended on at runtime. This constant is
 * exported for tooling that wants the value without re-parsing `package.json` (e.g. a script
 * checking a dispatcher's declared peer range against the spec it names).
 */
export const IR_VERSION = "0.6";

export default { IR_VERSION };
