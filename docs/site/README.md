# Warble docs site

The Warble documentation site, built with [Docusaurus](https://docusaurus.io/).

## Develop

```bash
npm install
npm start        # local dev server (runs gen:reference first)
npm run build    # production build to ./build (runs gen:reference first)
```

## Single source of truth for the Reference section

The **Reference** pages (`docs/reference/*.md`, except `cli.md`) are **generated** from the
authoritative specs in [`../spec/`](../spec) by `scripts/gen-reference.mjs`. Do not edit those
generated pages directly — they carry a "do not edit" banner and are overwritten on every build.

To change reference content, edit the matching spec in `../spec/` and regenerate:

```bash
npm run gen:reference   # docs/spec/*.md → docs/reference/*.md
```

Mapping: `authoring.md → profile-schema`, and `ir-schema` / `capability-model` / `blast-radius` /
`binding-spec` / `enforcement-seam` / `glossary` one-to-one. The generator injects frontmatter,
drops the spec's top-level heading, and rewrites sibling-spec links to site routes.

`reference/cli.md` is authored by hand (it has no single spec source — it tracks the CLI
definition) and is **not** generated.

> Because the generated pages are committed, a spec edited without regenerating shows up as a git
> diff after `npm run gen:reference` — a simple `gen:reference && git diff --exit-code docs/reference`
> check catches drift.
