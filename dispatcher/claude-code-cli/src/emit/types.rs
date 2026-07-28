//! Public dispatch-time knobs: the render flavor and the hybrid-realization selector.
//! Pure config enums with no dependencies; re-exported from the crate root via `emit`.

/// Render flavor ([`ir-schema.md`][spec-ir] §v0.3 §4). `programmatic` (default): the agent stays
/// read-only and emits a `{blocks}` envelope; a downstream renderer produces HTML deterministically.
/// `prompt`: the plain-file fallback — the agent is granted scoped write and writes
/// `dashboard.html` itself.
///
/// [spec-ir]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/ir-schema.md
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RenderFlavor {
    Programmatic,
    Prompt,
}

pub const DEFAULT_RENDER_FLAVOR: RenderFlavor = RenderFlavor::Programmatic;

impl RenderFlavor {
    pub fn as_str(&self) -> &'static str {
        match self {
            RenderFlavor::Programmatic => "programmatic",
            RenderFlavor::Prompt => "prompt",
        }
    }

    pub fn parse(value: &str) -> Option<RenderFlavor> {
        match value {
            "programmatic" => Some(RenderFlavor::Programmatic),
            "prompt" => Some(RenderFlavor::Prompt),
            _ => None,
        }
    }
}

/// How the file target realizes a hybrid binding's LOCAL step (`llm:per_step_provider`, see
/// [`capability-model.md`][spec-cap] §7.2): `BashScript` emits a Bash-run local-inference script
/// (needs `bash` in the allowlist); `McpServer` emits a `.mcp.json` registering `warble mcp-serve`
/// so the driver calls a `local_infer` MCP tool (a separate permission gate — no `bash`
/// widening). Default `BashScript`.
///
/// [spec-cap]: https://github.com/Canner/Warble/blob/v0.1.0/docs/spec/capability-model.md
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HybridRealization {
    #[default]
    BashScript,
    McpServer,
}

impl HybridRealization {
    pub fn parse(value: &str) -> Option<HybridRealization> {
        match value {
            "bash-script" => Some(HybridRealization::BashScript),
            "mcp-server" => Some(HybridRealization::McpServer),
            _ => None,
        }
    }
}
