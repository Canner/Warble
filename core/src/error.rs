//! Compile-time error type for the Warble front-end.

use thiserror::Error;

/// A compile failure with a human-facing message. Every compile-time check is
/// loud-fail: on the first violation `compile` returns one of these rather than
/// emitting a silently-wrong IR (see [`ir-schema.md`][spec-ir] §checks).
///
/// [spec-ir]: https://github.com/Canner/Warble/blob/main/docs/spec/ir-schema.md
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct CompileError(pub String);
