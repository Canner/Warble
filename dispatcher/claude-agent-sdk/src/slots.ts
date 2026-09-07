/**
 * Slot resolution — turning IR 0.7's declared slots into the text a model actually receives.
 *
 * The IR carries every variant and selects none; selecting is the host's job, and so is answering a
 * slot's `present_when`. This module is the seam between the two: a host hands in a table, and every
 * `{{ slot.<name> }}` in the prompt text is replaced before the prompt is sent.
 *
 * **Without this, the placeholder ships verbatim into the prompt.** Compile's template-syntax check
 * cannot catch that — `{{ slot.x }}` is valid syntax, it simply had no consumer downstream — so the
 * failure was silent, which is why {@link assertNoSlotReferences} exists and is not optional.
 *
 * The scanner deliberately mirrors the compiler's (`double_brace_bodies` / `is_slot_name` in
 * `core/src/compile.rs`) rather than using a regex of its own: compile decides what counts as a
 * reference, and a consumer that disagreed would either substitute something compile never checked
 * or leave something compile assumed was handled.
 */
import { DispatchError } from "./error.js";
import type { SlotDecl } from "./ir.js";

/**
 * What a host says about each slot, keyed by slot name:
 *
 * - a string — render this variant;
 * - `null` — the slot's `present_when` does not hold, so remove it entirely;
 * - absent — the host has no opinion, so render the declared `default`.
 *
 * A plain table rather than a callback, so what the model was told is decided before the run rather
 * than during it: it can be recorded, compared and fingerprinted. A callback could not be.
 */
export type SlotSupply = Readonly<Record<string, string | null>>;

/** Mirrors `is_slot_name` in the compiler. */
const SLOT_NAME = /^[a-z_][a-z0-9_]*$/;

interface Reference {
  /** Index of the opening `{{`. */
  start: number;
  /** Index just past the closing `}}`. */
  end: number;
  name: string;
}

/**
 * Every well-formed `{{ slot.<name> }}` in `raw`, in order.
 *
 * Mirrors the compiler's `double_brace_bodies`, including its treatment of an unterminated `{{` as
 * yielding nothing: it cannot be read as a reference, and guessing at what the author meant is
 * worse than leaving it alone. A `{{ … }}` whose body is not a slot reference (`{{project}}`, say)
 * is not returned — those are somebody else's substitution and must survive this pass untouched.
 */
function slotReferences(raw: string): Reference[] {
  const found: Reference[] = [];
  let cursor = 0;
  for (;;) {
    const open = raw.indexOf("{{", cursor);
    if (open === -1) return found;
    const bodyStart = open + 2;
    const close = raw.indexOf("}}", bodyStart);
    if (close === -1) return found;
    const body = raw.slice(bodyStart, close).trim();
    if (body.startsWith("slot.")) {
      const name = body.slice("slot.".length);
      if (SLOT_NAME.test(name)) found.push({ start: open, end: close + 2, name });
    }
    cursor = close + 2;
  }
}

/**
 * Resolve each declared slot to the text that will replace its references, or to `null` when the
 * host said it is not present.
 *
 * A slot's chosen variant may itself reference other slots — the compiler collects references from
 * variant text and validates them, so this is authored-legal — hence the recursion, with a visiting
 * set so a cycle is reported rather than spun on.
 *
 * @param decls every slot in scope for the text being resolved. That is the profile's slots PLUS
 *   the component's, together: compile checks the two layers separately, but it also folds the
 *   profile's `system_prompt` into each component's `brief` (`render_brief`), so by the time a
 *   consumer sees the IR one string carries references from both. Names are unique project-wide —
 *   compile refuses a collision — which is what makes one combined table unambiguous.
 * @param supply the host's table.
 * @param scope names the scope in errors ("component 'x'").
 */
export function resolveSlots(
  decls: readonly SlotDecl[],
  supply: SlotSupply,
  scope: string,
): ReadonlyMap<string, string | null> {
  const byName = new Map(decls.map((d) => [d.name, d]));
  const resolved = new Map<string, string | null>();
  const visiting = new Set<string>();

  const resolve = (name: string): string | null => {
    if (resolved.has(name)) return resolved.get(name)!;
    if (visiting.has(name)) {
      throw new DispatchError(
        `slot '${name}' in ${scope} is defined in terms of itself: a variant's text references a ` +
          `slot whose own variant references it back (chain: ${[...visiting, name].join(" -> ")}).`,
      );
    }
    const decl = byName.get(name)!;
    const choice = supply[name];

    if (choice === null) {
      resolved.set(name, null);
      return null;
    }
    if (choice === undefined) {
      // `default` covers "the host has no opinion on the wording". It cannot cover "the host has no
      // opinion on whether this should exist" — a slot exists conditionally precisely because its
      // text describes something that may have been withheld, and instructions for a withheld
      // capability are worse than no instructions. So an unanswered condition is a loud failure.
      if (decl.present_when !== undefined) {
        throw new DispatchError(
          `slot '${name}' in ${scope} declares a present_when condition, and nothing answered it. ` +
            `Supply the slot as a variant name to include it, or as null to remove it; falling back ` +
            `to the default would ship wording for something that may not be there.`,
        );
      }
    }
    const key = choice ?? decl.default;
    const text = decl.variants[key];
    if (text === undefined) {
      throw new DispatchError(
        `slot '${name}' in ${scope} was given variant '${key}', which it does not declare ` +
          `(declared: ${Object.keys(decl.variants).join(", ")}).`,
      );
    }
    visiting.add(name);
    const expanded = substitute(text, resolve, byName, scope);
    visiting.delete(name);
    resolved.set(name, expanded);
    return expanded;
  };

  for (const decl of decls) resolve(decl.name);
  return resolved;
}

/** Replace every slot reference in `raw`, resolving each on demand. */
function substitute(
  raw: string,
  resolve: (name: string) => string | null,
  byName: ReadonlyMap<string, SlotDecl>,
  scope: string,
): string {
  const refs = slotReferences(raw);
  if (refs.length === 0) return raw;
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    if (!byName.has(ref.name)) {
      throw new DispatchError(
        `prompt text in ${scope} references slot '${ref.name}', which is neither one of the ` +
          `component's slots nor one of the profile's.`,
      );
    }
    out += raw.slice(cursor, ref.start) + (resolve(ref.name) ?? "");
    cursor = ref.end;
  }
  return out + raw.slice(cursor);
}

/**
 * Apply a resolved scope to one piece of prompt text.
 *
 * A slot resolved to `null` leaves nothing behind — deliberately the empty string rather than any
 * variant, since the point of a condition that does not hold is that the wording must not appear.
 */
export function applySlots(
  raw: string,
  resolved: ReadonlyMap<string, string | null>,
  scope: string,
): string {
  const refs = slotReferences(raw);
  if (refs.length === 0) return raw;
  let out = "";
  let cursor = 0;
  for (const ref of refs) {
    if (!resolved.has(ref.name)) {
      throw new DispatchError(
        `prompt text in ${scope} references slot '${ref.name}', which is not declared there.`,
      );
    }
    out += raw.slice(cursor, ref.start) + (resolved.get(ref.name) ?? "");
    cursor = ref.end;
  }
  return out + raw.slice(cursor);
}

/**
 * Refuse prompt text that still carries a slot reference.
 *
 * The guard, not a formality. Every other failure in this file is loud on its own; this one catches
 * the case where a surface was never routed through {@link applySlots} at all — a new prompt-carrying
 * field, a path that assembles text somewhere unexpected — which is exactly how the original defect
 * arrived: the IR grew slots and nothing downstream was taught to consume them.
 */
export function assertNoSlotReferences(raw: string, owner: string): void {
  const refs = slotReferences(raw);
  if (refs.length > 0) {
    const names = [...new Set(refs.map((r) => r.name))].join(", ");
    throw new DispatchError(
      `${owner} still contains unresolved slot reference(s) (${names}) at dispatch. Prompt text ` +
        `must go through slot resolution before it is sent; shipping the placeholder would put ` +
        `literal '{{ slot.… }}' in front of the model.`,
    );
  }
}
