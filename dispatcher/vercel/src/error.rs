//! Error type for the vercel back-end.

use thiserror::Error;

/// A dispatch/resolve failure with a human-facing message. Every unsupported IR arm and every
/// failed capability resolution surfaces as one of these (loud-fail) rather than emitting a
/// silently-wrong bundle.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("{0}")]
pub struct DispatchError(pub String);

impl DispatchError {
    pub fn new(message: impl Into<String>) -> Self {
        DispatchError(message.into())
    }
}
