//! Slot resolution — turning IR 0.7's declared slots into the text a model actually receives.
//!
//! The IR carries every variant and selects none; selecting is the host's job, and so is answering a
//! slot's `present_when`. This module is the seam between the two: a host hands in a table, and every
//! `{{ slot.<name> }}` in the prompt text is replaced before anything is emitted.
//!
//! **Without this the placeholder ships verbatim.** The compiler's template-syntax check cannot
//! catch that — `{{ slot.x }}` is valid syntax that simply had no consumer downstream — so the
//! failure was silent, which is why [`assert_no_slot_references`] exists and is not optional.
//!
//! The scanner mirrors the compiler's `double_brace_bodies` / `is_slot_name` rather than inventing a
//! pattern of its own: the compiler decides what counts as a reference, and a consumer that
//! disagreed would either substitute something the compiler never checked or leave behind something
//! the compiler assumed was handled.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::error::DispatchError;
use crate::ir::SlotDecl;

/// What a host says about each slot, keyed by slot name.
///
/// `Some(variant)` renders that variant; `None` removes the slot because its `present_when` does not
/// hold; a name absent from the map means the host has no opinion and the declared `default` is
/// used.
///
/// A plain table rather than a callback, so what the model was told is decided before the run rather
/// than during it: it can be recorded, compared and fingerprinted.
pub type SlotSupply = BTreeMap<String, Option<String>>;

/// Whether `name` is a well-formed slot name: `[a-z_][a-z0-9_]*`. Mirrors the compiler's
/// `is_slot_name`.
fn is_slot_name(name: &str) -> bool {
    let mut chars = name.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// Byte spans of every well-formed `{{ slot.<name> }}` in `raw`, in order, with the name.
///
/// Mirrors the compiler's `double_brace_bodies`, including its treatment of an unterminated `{{` as
/// yielding nothing: it cannot be read as a reference, and guessing at the author's intent is worse
/// than leaving it alone. A `{{ … }}` whose body is not a slot reference (`{{project}}`, say) is not
/// returned — that is somebody else's substitution and must survive this pass untouched.
fn slot_references(raw: &str) -> Vec<(usize, usize, String)> {
    let mut found = Vec::new();
    let mut cursor = 0usize;
    while let Some(open) = raw[cursor..].find("{{") {
        let start = cursor + open;
        let body_start = start + 2;
        let Some(close) = raw[body_start..].find("}}") else {
            return found;
        };
        let end = body_start + close + 2;
        let body = raw[body_start..body_start + close].trim();
        if let Some(name) = body.strip_prefix("slot.") {
            if is_slot_name(name) {
                found.push((start, end, name.to_string()));
            }
        }
        cursor = end;
    }
    found
}

/// Resolve every slot in `decls` to the text that replaces its references, or to `None` when the
/// host said it is not present.
///
/// A chosen variant may itself reference other slots — the compiler collects references from variant
/// text and validates them, so this is authored-legal — hence the recursion, with a visiting set so
/// a cycle is reported rather than spun on.
///
/// `decls` is every slot in scope for the text being resolved: the profile's plus the component's,
/// together. The compiler checks the two layers separately but folds the profile's `system_prompt`
/// into each component's `brief`, so by the time a consumer sees the IR one string carries
/// references from both. Names are unique project-wide, which is what makes one table unambiguous.
pub fn resolve_slots(
    decls: &[SlotDecl],
    supply: &SlotSupply,
    scope: &str,
) -> Result<HashMap<String, Option<String>>, DispatchError> {
    let by_name: HashMap<&str, &SlotDecl> = decls.iter().map(|d| (d.name.as_str(), d)).collect();
    let mut resolved: HashMap<String, Option<String>> = HashMap::new();
    let mut visiting: Vec<String> = Vec::new();
    for decl in decls {
        resolve_one(
            &decl.name,
            &by_name,
            supply,
            scope,
            &mut resolved,
            &mut visiting,
        )?;
    }
    Ok(resolved)
}

fn resolve_one(
    name: &str,
    by_name: &HashMap<&str, &SlotDecl>,
    supply: &SlotSupply,
    scope: &str,
    resolved: &mut HashMap<String, Option<String>>,
    visiting: &mut Vec<String>,
) -> Result<Option<String>, DispatchError> {
    if let Some(done) = resolved.get(name) {
        return Ok(done.clone());
    }
    if visiting.iter().any(|v| v == name) {
        let mut chain = visiting.clone();
        chain.push(name.to_string());
        return Err(DispatchError(format!(
            "slot '{name}' in {scope} is defined in terms of itself: a variant's text references a \
             slot whose own variant references it back (chain: {}).",
            chain.join(" -> ")
        )));
    }
    let decl = by_name
        .get(name)
        .expect("caller resolves declared names only");
    let choice = supply.get(name);

    if let Some(None) = choice {
        resolved.insert(name.to_string(), None);
        return Ok(None);
    }
    if choice.is_none() && decl.present_when.is_some() {
        // `default` covers "the host has no opinion on the wording". It cannot cover "the host has
        // no opinion on whether this should exist" — a slot is conditional precisely because its
        // text describes something that may have been withheld, and instructions for a withheld
        // capability are worse than no instructions. So an unanswered condition is a loud failure.
        return Err(DispatchError(format!(
            "slot '{name}' in {scope} declares a present_when condition, and nothing answered it. \
             Supply the slot as a variant name to include it, or as absent-with-null to remove it; \
             falling back to the default would ship wording for something that may not be there."
        )));
    }
    let key = match choice {
        Some(Some(variant)) => variant.as_str(),
        _ => decl.default.as_str(),
    };
    let Some(text) = decl.variants.get(key) else {
        return Err(DispatchError(format!(
            "slot '{name}' in {scope} was given variant '{key}', which it does not declare \
             (declared: {}).",
            decl.variants.keys().cloned().collect::<Vec<_>>().join(", ")
        )));
    };

    visiting.push(name.to_string());
    let expanded = substitute(text, by_name, supply, scope, resolved, visiting)?;
    visiting.pop();
    resolved.insert(name.to_string(), Some(expanded.clone()));
    Ok(Some(expanded))
}

fn substitute(
    raw: &str,
    by_name: &HashMap<&str, &SlotDecl>,
    supply: &SlotSupply,
    scope: &str,
    resolved: &mut HashMap<String, Option<String>>,
    visiting: &mut Vec<String>,
) -> Result<String, DispatchError> {
    let refs = slot_references(raw);
    if refs.is_empty() {
        return Ok(raw.to_string());
    }
    let mut out = String::new();
    let mut cursor = 0usize;
    for (start, end, name) in refs {
        if !by_name.contains_key(name.as_str()) {
            return Err(DispatchError(format!(
                "prompt text in {scope} references slot '{name}', which is neither one of the \
                 component's slots nor one of the profile's."
            )));
        }
        out.push_str(&raw[cursor..start]);
        if let Some(text) = resolve_one(&name, by_name, supply, scope, resolved, visiting)? {
            out.push_str(&text);
        }
        cursor = end;
    }
    out.push_str(&raw[cursor..]);
    Ok(out)
}

/// Apply an already-resolved scope to one piece of prompt text.
///
/// A slot resolved to `None` leaves nothing behind — deliberately the empty string rather than any
/// variant, since the point of a condition that does not hold is that the wording must not appear.
pub fn apply_slots(
    raw: &str,
    resolved: &HashMap<String, Option<String>>,
    scope: &str,
) -> Result<String, DispatchError> {
    let refs = slot_references(raw);
    if refs.is_empty() {
        return Ok(raw.to_string());
    }
    let mut out = String::new();
    let mut cursor = 0usize;
    for (start, end, name) in refs {
        let Some(text) = resolved.get(&name) else {
            return Err(DispatchError(format!(
                "prompt text in {scope} references slot '{name}', which is not declared there."
            )));
        };
        out.push_str(&raw[cursor..start]);
        if let Some(text) = text {
            out.push_str(text);
        }
        cursor = end;
    }
    out.push_str(&raw[cursor..]);
    Ok(out)
}

/// Refuse prompt text that still carries a slot reference.
///
/// The guard, not a formality. Every other failure here is loud on its own; this one catches the
/// case where a surface was never routed through [`apply_slots`] at all — a newly added
/// prompt-carrying field, text assembled somewhere unexpected. That is exactly how the original
/// defect arrived: the IR grew slots and nothing downstream was taught to consume them.
pub fn assert_no_slot_references(raw: &str, owner: &str) -> Result<(), DispatchError> {
    let refs = slot_references(raw);
    if refs.is_empty() {
        return Ok(());
    }
    let mut names: Vec<String> = refs.into_iter().map(|(_, _, name)| name).collect();
    let seen: HashSet<String> = names.drain(..).collect();
    let mut names: Vec<String> = seen.into_iter().collect();
    names.sort();
    Err(DispatchError(format!(
        "{owner} still contains unresolved slot reference(s) ({}) at dispatch. Prompt text must go \
         through slot resolution before it is emitted; shipping the placeholder would put literal \
         '{{{{ slot.… }}}}' in front of the model.",
        names.join(", ")
    )))
}

/// Resolve every slot in an IR document, in place, before anything deserializes it into a
/// target-specific type.
///
/// **Why at the JSON level rather than on a typed IR.** The two Rust back-ends deserialize the same
/// document into two distinct `WarbleIr` types, so a typed pass would have to exist twice and the
/// two copies would eventually disagree — the same trap the scanner avoids by mirroring the
/// compiler's. One pass here means every target the CLI dispatches gets identical resolution, and
/// neither back-end's types need to know slots exist at all.
///
/// The `slots` declarations are removed once applied: the text is resolved, so anything downstream
/// that still found a declaration could only use it to resolve a second time, against text that no
/// longer holds references. What was chosen is a property of the supply, which the caller has.
///
/// A document declaring no slots is returned unchanged, so a pre-0.7-shaped IR is untouched.
pub fn resolve_ir_json(raw: &str, supply: &SlotSupply) -> Result<String, DispatchError> {
    let mut doc: serde_json::Value = serde_json::from_str(raw)
        .map_err(|e| DispatchError(format!("failed to parse IR while resolving slots: {e}")))?;

    let profile_slots = take_slot_decls(&mut doc, "the profile")?;
    let Some(components) = doc.get_mut("components").and_then(|c| c.as_array_mut()) else {
        return Ok(raw.to_string());
    };
    let mut touched = !profile_slots.is_empty();

    for node in components.iter_mut() {
        let id = node
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("<unnamed>")
            .to_string();
        let scope = format!("component '{id}'");
        let own = take_slot_decls(node, &scope)?;
        if own.is_empty() && profile_slots.is_empty() {
            continue;
        }
        touched = true;
        let decls: Vec<SlotDecl> = profile_slots.iter().chain(own.iter()).cloned().collect();
        let resolved = resolve_slots(&decls, supply, &scope)?;
        apply_to_node(node, &resolved, &scope)?;
    }

    if !touched {
        return Ok(raw.to_string());
    }
    serde_json::to_string_pretty(&doc).map_err(|e| {
        DispatchError(format!(
            "failed to re-serialize IR after resolving slots: {e}"
        ))
    })
}

/// Remove and parse an object's `slots` array, if it has one.
fn take_slot_decls(
    value: &mut serde_json::Value,
    scope: &str,
) -> Result<Vec<SlotDecl>, DispatchError> {
    let Some(object) = value.as_object_mut() else {
        return Ok(Vec::new());
    };
    let Some(raw) = object.remove("slots") else {
        return Ok(Vec::new());
    };
    serde_json::from_value(raw)
        .map_err(|e| DispatchError(format!("malformed slots declaration on {scope}: {e}")))
}

/// Rewrite a component node's prompt-carrying fields with the resolved text.
///
/// The field list is the same one the typed path rewrites. A prompt surface added later and missed
/// here is caught by [`assert_no_slot_references`] rather than shipping — that is the whole point of
/// having a guard as well as a rewrite.
fn apply_to_node(
    node: &mut serde_json::Value,
    resolved: &HashMap<String, Option<String>>,
    scope: &str,
) -> Result<(), DispatchError> {
    for field in ["brief", "prompt_fragment"] {
        if let Some(text) = node.get(field).and_then(|v| v.as_str()) {
            let next = apply_slots(text, resolved, scope)?;
            node[field] = serde_json::Value::String(next);
        }
    }
    if let Some(calls) = node.get_mut("llm_calls").and_then(|c| c.as_array_mut()) {
        for call in calls.iter_mut() {
            if let Some(text) = call.get("prompt").and_then(|v| v.as_str()) {
                let next = apply_slots(text, resolved, scope)?;
                call["prompt"] = serde_json::Value::String(next);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decl(name: &str, default: &str, variants: &[(&str, &str)], conditional: bool) -> SlotDecl {
        SlotDecl {
            name: name.to_string(),
            default: default.to_string(),
            variants: variants
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            present_when: conditional.then(|| serde_json::json!({"flag": "x"})),
        }
    }

    fn supply(pairs: &[(&str, Option<&str>)]) -> SlotSupply {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.map(str::to_string)))
            .collect()
    }

    const SCOPE: &str = "component 'c'";

    #[test]
    fn recognises_a_reference_with_and_without_inner_spacing() {
        let decls = [decl("policy", "base", &[("base", "BASE")], false)];
        let resolved = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        for raw in [
            "{{slot.policy}}",
            "{{ slot.policy }}",
            "{{   slot.policy   }}",
        ] {
            assert_eq!(apply_slots(raw, &resolved, SCOPE).expect("applies"), "BASE");
        }
    }

    #[test]
    fn leaves_an_unterminated_brace_alone_like_the_compiler_does() {
        let decls = [decl("policy", "base", &[("base", "BASE")], false)];
        let resolved = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        // The name must run to the end with nothing after it: a body containing spaces fails the
        // name check anyway, so a longer string would pass whether or not the scanner honoured the
        // missing `}}` — a test that cannot fail.
        let raw = "keep {{ slot.policy";
        assert_eq!(apply_slots(raw, &resolved, SCOPE).expect("applies"), raw);
    }

    #[test]
    fn leaves_other_placeholders_untouched() {
        let decls = [decl("policy", "base", &[("base", "BASE")], false)];
        let resolved = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        let raw = "{{project}} / {{project_name}}";
        assert_eq!(apply_slots(raw, &resolved, SCOPE).expect("applies"), raw);
    }

    #[test]
    fn a_name_the_compiler_would_reject_is_not_a_reference() {
        let decls = [decl("policy", "base", &[("base", "BASE")], false)];
        let resolved = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        let raw = "{{ slot.Policy }}";
        assert_eq!(apply_slots(raw, &resolved, SCOPE).expect("applies"), raw);
    }

    #[test]
    fn no_answer_renders_the_default_and_a_named_variant_wins() {
        let decls = [decl(
            "policy",
            "base",
            &[("base", "BASE"), ("terse", "T")],
            false,
        )];
        let default = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        assert_eq!(
            apply_slots("[{{ slot.policy }}]", &default, SCOPE).expect("applies"),
            "[BASE]"
        );
        let chosen =
            resolve_slots(&decls, &supply(&[("policy", Some("terse"))]), SCOPE).expect("resolves");
        assert_eq!(
            apply_slots("[{{ slot.policy }}]", &chosen, SCOPE).expect("applies"),
            "[T]"
        );
    }

    #[test]
    fn none_removes_the_slot_rather_than_falling_back() {
        let decls = [decl("policy", "base", &[("base", "BASE")], false)];
        let resolved =
            resolve_slots(&decls, &supply(&[("policy", None)]), SCOPE).expect("resolves");
        assert_eq!(
            apply_slots("[{{ slot.policy }}]", &resolved, SCOPE).expect("applies"),
            "[]"
        );
    }

    #[test]
    fn an_unanswered_condition_is_a_loud_failure() {
        let decls = [decl("policy", "base", &[("base", "BASE")], true)];
        let err = resolve_slots(&decls, &supply(&[]), SCOPE).expect_err("must refuse");
        assert!(
            err.0
                .contains("declares a present_when condition, and nothing answered it"),
            "unexpected message: {}",
            err.0
        );
    }

    #[test]
    fn an_undeclared_variant_is_refused_naming_the_declared_ones() {
        let decls = [decl(
            "policy",
            "base",
            &[("base", "BASE"), ("terse", "T")],
            false,
        )];
        let err = resolve_slots(&decls, &supply(&[("policy", Some("nope"))]), SCOPE)
            .expect_err("must refuse");
        assert!(
            err.0.contains("does not declare (declared: base, terse)"),
            "unexpected: {}",
            err.0
        );
    }

    #[test]
    fn a_variant_may_reference_another_slot() {
        let decls = [
            decl("outer", "only", &[("only", "<{{ slot.inner }}>")], false),
            decl("inner", "only", &[("only", "IN")], false),
        ];
        let resolved = resolve_slots(&decls, &supply(&[]), SCOPE).expect("resolves");
        assert_eq!(
            apply_slots("[{{ slot.outer }}]", &resolved, SCOPE).expect("applies"),
            "[<IN>]"
        );
    }

    #[test]
    fn a_cycle_between_variants_is_reported_not_spun_on() {
        let decls = [
            decl("a", "only", &[("only", "{{ slot.b }}")], false),
            decl("b", "only", &[("only", "{{ slot.a }}")], false),
        ];
        let err = resolve_slots(&decls, &supply(&[]), SCOPE).expect_err("must refuse");
        assert!(
            err.0.contains("is defined in terms of itself"),
            "unexpected: {}",
            err.0
        );
    }

    #[test]
    fn the_guard_refuses_text_that_still_carries_a_reference() {
        let err = assert_no_slot_references("a {{ slot.policy }} b", "the agent file")
            .expect_err("must refuse");
        assert!(
            err.0.contains("unresolved slot reference(s) (policy)"),
            "unexpected: {}",
            err.0
        );
        assert_no_slot_references("{{project}} and a lone {{", "x").expect("not references");
    }

    const IR: &str = r#"{
      "warble_ir_version": "0.8",
      "profile": "p",
      "slots": [{"name": "charter", "default": "base", "variants": {"base": "CHARTER", "alt": "ALT"}}],
      "components": [{
        "id": "c1",
        "brief": "framing: {{ slot.charter }} / {{ slot.local }}",
        "prompt_fragment": "frag {{ slot.local }}",
        "llm_calls": [{"name": "s1", "prompt": "step {{ slot.charter }}"}],
        "slots": [{"name": "local", "default": "d", "variants": {"d": "LOCAL"}}]
      }]
    }"#;

    #[test]
    fn resolves_both_layers_of_an_ir_document_and_drops_the_declarations() {
        let out = resolve_ir_json(IR, &supply(&[("charter", Some("alt"))])).expect("resolves");
        let doc: serde_json::Value = serde_json::from_str(&out).expect("valid json");
        let node = &doc["components"][0];
        assert_eq!(node["brief"], "framing: ALT / LOCAL");
        assert_eq!(node["prompt_fragment"], "frag LOCAL");
        assert_eq!(node["llm_calls"][0]["prompt"], "step ALT");
        assert!(
            doc.get("slots").is_none(),
            "profile declarations are consumed, not carried"
        );
        assert!(
            node.get("slots").is_none(),
            "component declarations are consumed, not carried"
        );
    }

    #[test]
    fn an_ir_declaring_no_slots_is_returned_byte_identical() {
        let raw = r#"{"warble_ir_version":"0.8","profile":"p","components":[{"id":"c1","brief":"plain"}]}"#;
        assert_eq!(resolve_ir_json(raw, &supply(&[])).expect("resolves"), raw);
    }
}

#[cfg(test)]
mod emit_guard_tests {
    use crate::ir::WarbleIr;
    use std::path::Path;

    /// A library caller that skips the CLI's resolution pass must be refused, not served an agent
    /// file containing the literal placeholder. Before the guard was wired into `emit`, this
    /// function existed and nothing called it.
    #[test]
    fn emit_refuses_an_ir_whose_prompt_text_still_holds_a_slot_reference() {
        let raw = include_str!("../../../examples/analysis-agent/ir.golden.json");
        let mut doc: serde_json::Value = serde_json::from_str(raw).expect("golden parses");
        let node = &mut doc["components"][0];
        let brief = node["brief"].as_str().unwrap_or("").to_string();
        node["brief"] = serde_json::Value::String(format!("{brief}\n{{{{ slot.charter }}}}"));
        doc["components"]
            .as_array_mut()
            .expect("golden components")
            .truncate(1);
        let ir: WarbleIr = serde_json::from_value(doc).expect("still an IR");

        let dir = tempfile::tempdir().expect("tempdir");
        let err = crate::emit_claude_code(
            &ir,
            Path::new(dir.path()),
            "claude-code:headless",
            crate::DEFAULT_RENDER_FLAVOR,
        )
        .expect_err("must refuse an unresolved slot reference");
        assert!(
            err.0
                .contains("still contains unresolved slot reference(s) (charter)"),
            "unexpected message: {}",
            err.0
        );
    }
}
