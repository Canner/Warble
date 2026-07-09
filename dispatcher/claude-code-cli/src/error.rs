//! Error type for the Claude Code back-end.

use thiserror::Error;

/// A dispatch/render/resolve failure with a human-facing message. Every unsupported IR arm and
/// every failed capability resolution surfaces as one of these (loud-fail) rather than emitting a
/// silently-wrong agent.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct DispatchError(pub String);

impl DispatchError {
    pub fn new(message: impl Into<String>) -> Self {
        DispatchError(message.into())
    }
}
