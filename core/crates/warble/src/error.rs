//! Compile-time error type for the Warble front-end.

use thiserror::Error;

/// A compile failure with a human-facing message. Every compile-time check is
/// loud-fail: on the first violation `compile` returns one of these rather than
/// emitting a silently-wrong IR (see `spec/ir-schema.md` §checks).
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct CompileError(pub String);
