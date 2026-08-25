# Warble docs site

The Warble documentation site, built with [Docusaurus](https://docusaurus.io/).

## Develop

```bash
npm install
npm start        # local dev server (runs gen:site first)
npm run build    # production build to ./build (runs gen:site first)
```

## Single source of truth for the Reference section and the roadmap

The **Reference** pages (`docs/reference/*.md`, except `cli.md`) are **generated** from the
authoritative specs in [`../spec/`](../spec), and the **community roadmap page**
(`docs/community/roadmap.md`) is generated from [`../roadmap.md`](../roadmap.md) — both by the same
`scripts/gen-reference.mjs`. Do not edit any of those generated pages directly — they carry a "do
not edit" banner and are overwritten on every build.

To change reference content, edit the matching spec in `../spec/` and regenerate:

```bash
npm run gen:reference   # docs/spec/*.md → docs/reference/*.md
                         # ../roadmap.md  → docs/community/roadmap.md
```

Mapping: `authoring.md → profile-schema`, and `ir-schema` / `capability-model` / `blast-radius` /
`binding-spec` / `enforcement-seam` / `glossary` one-to-one; `../roadmap.md → community/roadmap`.
The generator injects frontmatter, drops the source's top-level heading, and rewrites sibling
links (to other specs, or to the roadmap) to site routes.

To change the roadmap, edit `docs/roadmap.md` at the repo root (**not**
`docs/site/docs/community/roadmap.md`) and regenerate the same way.

`reference/cli.md` is authored by hand (it has no single spec source — it tracks the CLI
definition) and is **not** generated.

> Because the generated pages are committed, a source edited without regenerating shows up as a
> git diff after `npm run gen:reference` — a simple `gen:reference && git diff --exit-code
> docs/reference docs/community/roadmap.md` check catches drift.

## AI-readable index

`npm run gen:llms` reads every docs page's `title`, `description`, and route, then writes
`static/llms.txt`. Docusaurus serves that file unchanged at `/llms.txt`. The generated index uses
root-relative links so it remains valid when the site moves to its final host.

Run `npm run gen:site` to regenerate both the reference/roadmap mirrors and `llms.txt`; the
production build and local dev server run it automatically.
