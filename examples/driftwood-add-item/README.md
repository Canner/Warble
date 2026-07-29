# driftwood-add-item — `add_item` through an admin **web form**

A mutating profile over the same [`../driftwood-wren`](../driftwood-wren) semantic layer that
[`../driftwood-agent`](../driftwood-agent) only reads. One component, `add_item`, adds one product to
the catalog by doing what a human does:

1. **`open_add_form`** (`cheap`) — go to page A (`list_page`), scroll until button B (`add_button`) is
   in view, click it, snapshot the form → `form_handle`
2. **`fill_item_name`** (`strong`) — decide the canonical name and type it into the name field →
   `filled_form`
3. **`submit_form`** (`cheap`) — dry-run → human approval → submit **once** → `submission_receipt`

## Why this example exists

`hub/edit_pipeline` is the other mutating component, and it writes through the **filesystem**
(propose a diff → gate → apply). This one keeps the *identical* mutating spine — `type: mutating`,
`realization_kind: gated-tool`, `outcome.kind: mutation`, a locked guardrail floor — while the apply
is three borrowed **UI** actions. Nothing in `component.yml` names a mechanism (no selector, no
browser engine): it declares `browser_automation` + `borrowed_actions`, and legalizing those onto a
runtime is the back-end's job.

Where the semantic layer earns its keep: step 2 is the only `strong` step because the form field is
**not** a free text box. It maps to a column of the pinned `target_model` (`products.name`), so the
value must satisfy that column plus the project's knowledge rules, and must not collide with a row
that already exists — checks a generic browser agent cannot make. Mechanical navigation stays cheap.

Guardrail floor, all locked: `must_dry_run`, `human_approval`, `write_authz` (scoped to the pinned
add-form), `single_submit`; `row_write_limit: 1` is overridable. `single_submit` carries the weight
that `rollback_available` carries in `edit_pipeline`: a row created through a web form has no
`git checkout` to undo it, so the floor is "never write twice", and an *unknown* outcome must stop
rather than retry.

Layering (iron rule respected): the component names no concrete page, button or model — the profile
pins `target_model` / `list_page` / `add_button` and overrides `name_field`; the admin base URL, the
authenticated browser session, the requested item name and the wren connection are all
`source: runtime-injected`, so staging-vs-prod and today's value never enter git.

## Run it

```sh
warble compile examples/driftwood-add-item -o ir.json     # ✅ passes (precondition: pass)
warble manifest ir.json                                   # ✅ the capability manifest
warble dispatch ir.json --target claude-code:interactive --out dispatched
```

Compile and manifest succeed as-is. **Dispatch loud-fails on purpose** — see below.

## Wall-hits this example surfaces (all reproduced, not hypothetical)

1. **`browser_automation` is not in any target's capability profile** → dispatch aborts on both
   claude-code targets: *"capability is not declared in the target's capability profile — unknown
   means it cannot be guaranteed"*. Correct behavior (unknown = safety-critical fail, never a silent
   degrade), and the example's second lesson: a UI-mutating agent needs a target that declares the
   capability. Adding one entry to `interactive_profile()` —
   `("browser_automation", entry(RealizeVia, Some("mcp-browser"), Runtime, SafetyCritical, None))` —
   makes the whole component resolve clean (verified: every other capability lands
   native/realize-via, `human_approval` **native** on interactive, `fail` on headless as designed).
2. **`borrowed_actions` are declared but not legalized.** With the capability granted, the emitted
   agent's tool allowlist is still `Read, Bash(wren:*), Edit, Write` — the six `browser_*` actions
   reach no tool. Today the IR carries the intent; no back-end wires it.
3. **`version_control` is implied by `outcome.kind: mutation`**, and the emitted settings comment
   asserts the `edit_pipeline` lifecycle ("blast-radius gate → apply → rollback via git"). Neither
   fits a form submission: there is no git checkpoint for a row in a production table. Hence
   `single_submit` here — the shape of "mutation" that a UI write needs is not the file-write shape.
4. **A profile's `bind` values are compile-checked but not carried into the IR** (same for
   `mutate-agent`'s `target: orders`): `products` / `/admin/catalog/products` / `New product` are
   validated as supplied, then dropped, so a dispatched agent cannot read what was pinned.

None of these are worked around in this example — it is authored the way the spec says and left to
fail loudly where the toolchain is honest about not supporting something yet.
