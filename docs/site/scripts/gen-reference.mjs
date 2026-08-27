#!/usr/bin/env node
// Generate generated docs-site pages from their single-source-of-truth files: the
// Reference pages from docs/spec/*.md, and the community roadmap page from
// docs/roadmap.md.
//
// Single source of truth: edit the source (docs/spec/*.md or docs/roadmap.md), then
// re-run `npm run gen:reference` (also runs automatically via the `prebuild`/`prestart`
// hooks). The generated pages carry a "do not edit" banner; a stale page shows up as a
// git diff after regeneration.
//
// `reference/cli.md` is NOT generated here — it has no single spec source (it is authored
// from the clap CLI definition) and is maintained by hand.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..'); // docs/site
const DOCS_DIR = resolve(SITE, '..'); // docs
const SPEC_DIR = resolve(DOCS_DIR, 'spec'); // docs/spec
const REPO_ROOT = resolve(DOCS_DIR, '..'); // repo root
const REFERENCE_OUT_DIR = resolve(SITE, 'docs/reference');
const COMMUNITY_OUT_DIR = resolve(SITE, 'docs/community');

// Base for step 3 below: repo-root docs (CONTRIBUTING.md, README.md, ...) aren't part
// of the site, so a link to one is rewritten to point at the file on GitHub instead.
// Pinned to `main`, not a release tag: unlike a docs.rs page (immutable per version),
// the docs site tracks the current state of the repo, so root-doc links should too.
const GITHUB_BLOB_ROOT = 'https://github.com/Canner/Warble/blob/main';

// Each entry is one generated page and the single source file it is generated from.
// `key` doubles as the source basename (`${key}.md` under `srcDir`) and the lookup key
// used to rewrite other pages' links that point at this source.
const SOURCES = [
  {
    key: 'authoring',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'profile-schema',
    route: '/reference/profile-schema',
    title: 'Profile & component authoring',
    description:
      'How Warble profiles and components are declared — the profile/component/IR layering, context binding, tiers, guardrails, and the render contract.',
  },
  {
    key: 'ir-schema',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'ir-schema',
    route: '/reference/ir-schema',
    title: 'IR schema',
    description:
      'The Warble IR compile contract — the language-neutral seam every back-end consumes.',
  },
  {
    key: 'capability-model',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'capability-model',
    route: '/reference/capability-model',
    title: 'Capability model',
    description:
      "How dispatch resolves each IR-declared capability against a target runtime's capability profile — native, realize-via, degrade, or fail.",
  },
  {
    key: 'blast-radius',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'blast-radius',
    route: '/reference/blast-radius',
    title: 'Blast radius',
    description:
      'The as-built blast-radius query over the semantic lineage graph — types, construction, the algorithm, worked examples, and current limitations.',
  },
  {
    key: 'binding-spec',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'binding-spec',
    route: '/reference/binding-spec',
    title: 'Tier-to-model binding spec',
    description:
      'The authoritative --models-config tier-to-model binding format (binding_spec_version 1.0) consumed by every back-end.',
  },
  {
    key: 'provider-fragment',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'provider-fragment',
    route: '/reference/provider-fragment',
    title: 'Provider fragment spec',
    description:
      'The dispatch-time capability binding (--provider) that supplies domain capabilities a back-end deliberately does not hardcode.',
  },
  {
    key: 'enforcement-seam',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'enforcement-seam',
    route: '/reference/enforcement-seam',
    title: 'Enforcement seam',
    description:
      'How a dispatched target actually enforces a guardrail at runtime — the five enforcement points and the two enforcement layers.',
  },
  {
    key: 'glossary',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'glossary',
    route: '/reference/glossary',
    title: 'Glossary',
    description: "One-line definitions of Warble's load-bearing terms.",
  },
  {
    key: 'roadmap',
    srcDir: DOCS_DIR,
    outDir: COMMUNITY_OUT_DIR,
    out: 'roadmap',
    route: '/community/roadmap',
    title: 'Roadmap & status',
    description:
      "Warble's behavior maturity staging — MVP through Assertive and Mutating to the scaffolded Orchestrating stage — plus cross-cutting work and the eval loop.",
    // The reference pages' banner calls their source "the spec"; the roadmap isn't a
    // spec, so it gets its own noun while keeping the same banner shape.
    editNoun: 'the roadmap',
  },
];

// key -> site route, for rewriting links that point at one of these sources.
const ROUTE = Object.fromEntries(SOURCES.map(({ key, route }) => [key, route]));
const SOURCE_NAMES = new Set(Object.keys(ROUTE));

// Explicit heading-id pins where an in-page anchor link would not match the auto-slug.
const HEADING_IDS = {
  'ir-schema': [
    { match: /^## Resolution rules \(front-end[^\n]*\)/m, id: 'resolution-rules' },
    { match: /^## v0\.3 — fine-grained context binding/m, id: 'v03--fine-grained-context-binding' },
  ],
};

function transform(key, src, srcDir) {
  let body = src;

  // 1. Drop the leading top-level H1 (frontmatter title replaces it).
  body = body.replace(/^#\s+.*\r?\n/, '');

  // 2. Rewrite markdown links to other generated sources (sibling specs, or the
  //    roadmap) → site routes. Strips any number of leading relative-path segments
  //    (`./`, `../`, or a named subdirectory like `spec/`) so this works regardless of
  //    how many directory levels separate the linking file from its target.
  body = body.replace(
    /\]\((?:\.{1,2}\/)*(?:[\w-]+\/)*([a-z0-9-]+)\.md(#[\w-]+)?\)/g,
    (m, name, anchor = '') => (ROUTE[name] ? `](${ROUTE[name]}${anchor || ''})` : m),
  );

  // 3. Rewrite links that climb out of docs/ (`../../CONTRIBUTING.md`, etc.) into
  //    absolute GitHub URLs. Those relative paths are correct in the source's own
  //    location (docs/spec/ or docs/), but the generated page lives under
  //    docs/site/docs/reference/ (or community/), where the same path no longer
  //    resolves — and the target (a repo-root doc like CONTRIBUTING.md) isn't part of
  //    the site at all, so there's no site route to rewrite it to (unlike step 2).
  //    Links that stay inside docs/ are left for step 2 or the site's own resolution.
  body = body.replace(/\]\((\.\.\/[^)#\s]+)(#[\w-]+)?\)/g, (m, relPath, anchor = '') => {
    const resolved = resolve(srcDir, relPath);
    if (!relative(DOCS_DIR, resolved).startsWith('..')) return m; // still under docs/
    const repoRelative = relative(REPO_ROOT, resolved);
    if (repoRelative.startsWith('..')) return m; // escapes the repo entirely; leave it
    return `](${GITHUB_BLOB_ROOT}/${repoRelative.split(sep).join('/')}${anchor || ''})`;
  });

  // 4. De-suffix bare inline-code mentions: `ir-schema.md` → `ir-schema`
  //    (only for known source names, so `RUN.md`, `answer.md`, etc. are untouched).
  body = body.replace(/`([a-z0-9-]+)\.md`/g, (m, name) => (SOURCE_NAMES.has(name) ? `\`${name}\`` : m));

  // 5. Pin heading ids where an in-page anchor link needs them.
  for (const { match, id } of HEADING_IDS[key] || []) {
    body = body.replace(match, (line) => (line.includes('{#') ? line : `${line} {#${id}}`));
  }

  return body.replace(/^\s+/, '');
}

let count = 0;
for (const { key, srcDir, outDir, out, title, description, editNoun = 'the spec' } of SOURCES) {
  mkdirSync(outDir, { recursive: true });
  const srcPath = resolve(srcDir, `${key}.md`);
  const src = readFileSync(srcPath, 'utf8');
  const srcLabel = relative(REPO_ROOT, srcPath);
  const banner = `<!-- @generated from ${srcLabel} by scripts/gen-reference.mjs — do not edit; edit ${editNoun} and re-run \`npm run gen:reference\` -->`;
  const frontmatter = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---`;
  const page = `${frontmatter}\n\n${banner}\n\n${transform(key, src, srcDir)}`;
  writeFileSync(resolve(outDir, `${out}.md`), page.endsWith('\n') ? page : `${page}\n`);
  count += 1;
}
console.log(`gen-reference: wrote ${count} generated page(s) (docs/reference/, docs/community/roadmap.md)`);

// The npm package `@warble/ir-spec` bundles the IR spec as a snapshot rather than linking to it:
// its version is frozen the moment it publishes, so a link to `main` would show whatever the spec
// became later rather than what that IR version actually specified. The snapshot has to be a real
// committed file — `npm pack` does not dereference a symlink, it silently omits the file and ships
// a package missing its spec. A real file copied by hand drifts, so it is synced here instead,
// riding the same mandatory regeneration step and the same CI drift check as the pages above.
//
// Verbatim, not transformed: the reference pages are rewritten for Docusaurus, but this copy must
// stay byte-identical to the source because `just publish-check` diffs the two and fails a release
// if they disagree.
const IR_SPEC_SNAPSHOT = resolve(REPO_ROOT, 'packages/ir-spec/ir-schema.md');
writeFileSync(IR_SPEC_SNAPSHOT, readFileSync(resolve(SPEC_DIR, 'ir-schema.md'), 'utf8'));
console.log(`gen-reference: synced ${relative(REPO_ROOT, IR_SPEC_SNAPSHOT)} from docs/spec/ir-schema.md`);
