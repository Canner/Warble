//! Public dispatch-time knobs: render flavor, context injection, and hybrid realization.
//! Pure config enums with no dependencies; re-exported from the crate root via `emit`.

use crate::ir::WarbleIr;
use serde::Serialize;

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

/// Which semantic context is embedded into emitted agent prompts.
///
/// This is a runtime binding choice, not component identity or IR control flow. Both modes carry
/// the same deterministic schema digest; `mdl+knowledge` additionally embeds the host-supplied
/// business rules. The dispatcher never reads the bound project itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextInjectionMode {
    MdlOnly,
    #[serde(rename = "mdl+knowledge")]
    MdlWithKnowledge,
}

pub const DEFAULT_CONTEXT_INJECTION: ContextInjectionMode = ContextInjectionMode::MdlOnly;

impl ContextInjectionMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContextInjectionMode::MdlOnly => "mdl-only",
            ContextInjectionMode::MdlWithKnowledge => "mdl+knowledge",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "mdl-only" => Some(Self::MdlOnly),
            "mdl+knowledge" => Some(Self::MdlWithKnowledge),
            _ => None,
        }
    }
}

/// Normalized, runtime-neutral context payload supplied to the dispatcher by its host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextInjection {
    mode: ContextInjectionMode,
    schema_digest: String,
    knowledge: String,
}

/// Public report identity written beside every dispatched agent and copied into eval reports.
/// It intentionally contains fingerprints/counts rather than private knowledge text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ContextInjectionReport {
    pub mode: &'static str,
    pub schema_digest_fingerprint: String,
    pub knowledge_fingerprint: Option<String>,
    pub knowledge_chars: usize,
}

impl ContextInjection {
    /// Build the payload from compiled IR plus host-supplied knowledge. `knowledge` is consumed only
    /// in `mdl+knowledge`; callers should not read it for `mdl-only`.
    pub fn from_ir(ir: &WarbleIr, mode: ContextInjectionMode, knowledge: Option<String>) -> Self {
        let schema_digest = build_schema_digest(ir.context_binding.resolved.as_ref());
        let knowledge = match mode {
            ContextInjectionMode::MdlOnly => String::new(),
            ContextInjectionMode::MdlWithKnowledge => {
                normalize_text(knowledge.as_deref().unwrap_or(""))
            }
        };
        Self {
            mode,
            schema_digest,
            knowledge,
        }
    }

    pub fn mode(&self) -> ContextInjectionMode {
        self.mode
    }

    pub fn prompt_section(&self) -> String {
        let knowledge = match self.mode {
            ContextInjectionMode::MdlOnly => "Knowledge rules are intentionally excluded for this run. Do NOT run `wren context instructions` or read `knowledge/rules`; answer from the MDL schema and the question only.".to_string(),
            ContextInjectionMode::MdlWithKnowledge if self.knowledge.is_empty() => "Knowledge injection is enabled, but the host found no non-empty business rules. Do NOT re-run `wren context instructions`; there are no injected rules to recover.".to_string(),
            ContextInjectionMode::MdlWithKnowledge => format!(
                "The host embedded the authoritative business rules below. Apply every relevant rule and do NOT run `wren context instructions` again.\n\n<knowledge_rules>\n{}\n</knowledge_rules>",
                self.knowledge
            ),
        };
        format!(
            "## Injected context\n\nContext injection mode: `{}`. Use this compiled schema digest before calling `wren context show`; introspect only when the question needs details absent from the digest.\n\n<schema_digest>\n{}\n</schema_digest>\n\n{}",
            self.mode.as_str(),
            self.schema_digest,
            knowledge
        )
    }

    pub fn report(&self) -> ContextInjectionReport {
        ContextInjectionReport {
            mode: self.mode.as_str(),
            schema_digest_fingerprint: fingerprint(&self.schema_digest),
            knowledge_fingerprint: (self.mode == ContextInjectionMode::MdlWithKnowledge)
                .then(|| fingerprint(&self.knowledge)),
            knowledge_chars: self.knowledge.chars().count(),
        }
    }
}

fn normalize_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .trim()
        .to_string()
}

/// Stable FNV-1a identity for report diagnostics. The eval cache does not trust this short
/// fingerprint: it hashes the complete emitted directory independently for `agent_sha`.
fn fingerprint(value: &str) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("fnv1a64:{hash:016x}")
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(v) => v.to_string(),
        serde_json::Value::Number(v) => v.to_string(),
        serde_json::Value::String(v) => serde_json::to_string(v).expect("string serializes"),
        serde_json::Value::Array(values) => format!(
            "[{}]",
            values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",")
        ),
        serde_json::Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by_key(|(key, _)| *key);
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("key serializes"),
                        canonical_json(value)
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn sorted_entries(value: Option<&serde_json::Value>, key: &str) -> Vec<String> {
    let mut entries = value
        .and_then(|v| v.get(key))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|entry| match entry {
            serde_json::Value::String(s) => s.clone(),
            other => canonical_json(other),
        })
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn digest_line(label: &str, entries: Vec<String>) -> String {
    if entries.is_empty() {
        format!("{label}: (none)")
    } else {
        format!("{label}: {}", entries.join(", "))
    }
}

fn build_schema_digest(resolved: Option<&serde_json::Value>) -> String {
    let lineage = resolved
        .and_then(|v| v.get("lineage"))
        .map(canonical_json)
        .unwrap_or_else(|| "unavailable".to_string());
    [
        digest_line("Models", sorted_entries(resolved, "models")),
        digest_line("Metrics", sorted_entries(resolved, "metrics")),
        digest_line("Dimensions", sorted_entries(resolved, "dimensions")),
        digest_line(
            "Time dimensions",
            sorted_entries(resolved, "time_dimensions"),
        ),
        format!("Lineage: {lineage}"),
    ]
    .join("\n")
}

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
