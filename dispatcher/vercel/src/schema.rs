//! JSON-Schema builder for the bundle's `output_schema` — the structured-output contract a
//! Vercel AI SDK tool-loop validates an agent's final turn against.
//!
//! Render-block field types use a small closed grammar (see `docs/spec/ir-schema.md`), echoed here
//! into standard JSON Schema:
//!
//! - trailing `?` ⇒ nullable (outermost modifier; e.g. `number?`, `string[]?`)
//! - trailing `[]` on a primitive ⇒ array of that primitive (e.g. `string[]`, `row[]`)
//! - `|`-separated primitives ⇒ a type union (e.g. `number|string`)
//! - `|`-separated non-primitives ⇒ a JSON-Schema string enum (e.g. `bar|line|pie|area|scatter`)
//! - primitive keywords: `string`, `number`, `boolean`, `row` (`row` ⇒ `{"type": "object"}`, an
//!   opaque record whose shape this back-end never inspects)

use crate::ir::{Effect, RenderBlock};
use serde_json::{json, Map, Value};

const PRIMITIVES: [&str; 4] = ["string", "number", "boolean", "row"];

fn is_primitive(name: &str) -> bool {
    PRIMITIVES.contains(&name)
}

fn primitive_schema(name: &str) -> Value {
    match name {
        "string" => json!({"type": "string"}),
        "number" => json!({"type": "number"}),
        "boolean" => json!({"type": "boolean"}),
        "row" => json!({"type": "object"}),
        other => json!({"type": "string", "enum": [other]}),
    }
}

/// Add `"null"` to a schema's `type`, converting a bare string type into a two-element union if
/// needed. Leaves non-`type`-bearing schemas (e.g. `enum`-only) untouched at the wrapper site —
/// callers only apply this to schemas produced by `primitive_schema`/union construction, which
/// always carry a `type`.
fn make_nullable(schema: Value) -> Value {
    match schema {
        Value::Object(mut map) => {
            if let Some(existing) = map.remove("type") {
                let widened = match existing {
                    Value::String(s) => json!([s, "null"]),
                    Value::Array(mut items) => {
                        if !items.iter().any(|v| v == "null") {
                            items.push(json!("null"));
                        }
                        Value::Array(items)
                    }
                    other => other,
                };
                map.insert("type".to_string(), widened);
            }
            Value::Object(map)
        }
        other => other,
    }
}

/// Translate one render-block field-type string into a JSON-Schema fragment.
pub fn field_type_to_schema(type_str: &str) -> Value {
    let (base, nullable) = match type_str.strip_suffix('?') {
        Some(rest) => (rest, true),
        None => (type_str, false),
    };

    let schema = if let Some(elem) = base.strip_suffix("[]") {
        json!({"type": "array", "items": primitive_schema(elem)})
    } else if base.contains('|') {
        let alternatives: Vec<&str> = base.split('|').collect();
        if alternatives.iter().all(|alt| is_primitive(alt)) {
            let types: Vec<Value> = alternatives
                .iter()
                .map(|alt| Value::String(alt.to_string()))
                .collect();
            json!({"type": types})
        } else {
            json!({"type": "string", "enum": alternatives})
        }
    } else {
        primitive_schema(base)
    };

    if nullable {
        make_nullable(schema)
    } else {
        schema
    }
}

/// Build the object schema for one render block: a `type` discriminator (the block's literal
/// type name) plus one property per declared field, non-nullable fields marked `required`.
pub fn render_block_schema(block: &RenderBlock) -> Value {
    let mut properties = Map::new();
    properties.insert("type".to_string(), json!({"const": block.block_type}));

    let mut required = vec![Value::String("type".to_string())];
    for (name, type_str) in &block.fields {
        properties.insert(name.clone(), field_type_to_schema(type_str));
        if !type_str.ends_with('?') {
            required.push(Value::String(name.clone()));
        }
    }

    json!({
        "type": "object",
        "properties": properties,
        "required": required,
    })
}

/// Build the full `output_schema` for a component's effect, matching the render-contract
/// Envelope shape (`{blocks, summary, verified}`) every vercel agent's structured output conforms
/// to, regardless of how many render block types it declares.
pub fn output_schema_for(effect: &Effect) -> Value {
    let block_schemas: Vec<Value> = effect
        .render_blocks
        .iter()
        .map(render_block_schema)
        .collect();

    let blocks_items = match block_schemas.len() {
        0 => json!({"type": "object"}),
        1 => block_schemas
            .into_iter()
            .next()
            .expect("len checked == 1 by the match arm"),
        _ => json!({"anyOf": block_schemas}),
    };

    json!({
        "type": "object",
        "properties": {
            "blocks": {"type": "array", "items": blocks_items},
            "summary": {"type": ["string", "null"]},
            "verified": {"type": ["boolean", "null"]},
        },
        "required": ["blocks"],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primitive_union_becomes_type_array() {
        let schema = field_type_to_schema("number|string");
        assert_eq!(schema, json!({"type": ["number", "string"]}));
    }

    #[test]
    fn non_primitive_union_becomes_string_enum() {
        let schema = field_type_to_schema("bar|line|pie|area|scatter");
        assert_eq!(
            schema,
            json!({"type": "string", "enum": ["bar", "line", "pie", "area", "scatter"]})
        );
    }

    #[test]
    fn nullable_primitive_widens_type_to_include_null() {
        let schema = field_type_to_schema("number?");
        assert_eq!(schema, json!({"type": ["number", "null"]}));
    }

    #[test]
    fn array_of_primitive() {
        let schema = field_type_to_schema("string[]");
        assert_eq!(
            schema,
            json!({"type": "array", "items": {"type": "string"}})
        );
    }

    #[test]
    fn array_of_row_is_array_of_object() {
        let schema = field_type_to_schema("row[]");
        assert_eq!(
            schema,
            json!({"type": "array", "items": {"type": "object"}})
        );
    }

    #[test]
    fn bare_string_is_unmodified() {
        assert_eq!(field_type_to_schema("string"), json!({"type": "string"}));
    }
}
