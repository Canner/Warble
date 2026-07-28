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
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..'); // docs/site
const DOCS_DIR = resolve(SITE, '..'); // docs
const SPEC_DIR = resolve(DOCS_DIR, 'spec'); // docs/spec
const REPO_ROOT = resolve(DOCS_DIR, '..'); // repo root
const REFERENCE_OUT_DIR = resolve(SITE, 'docs/reference');
const COMMUNITY_OUT_DIR = resolve(SITE, 'docs/community');

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
      'The Warble IR compile contract (warble_ir_version 0.3) — the language-neutral seam every back-end consumes.',
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
    key: 'enforcement-seam',
    srcDir: SPEC_DIR,
    outDir: REFERENCE_OUT_DIR,
    out: 'enforcement-seam',
    route: '/reference/enforcement-seam',
    title: 'Enforcement seam',
    description:
      'How a dispatched target actually enforces a guardrail at runtime — the four enforcement points and the two enforcement layers.',
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

function transform(key, src) {
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

  // 3. De-suffix bare inline-code mentions: `ir-schema.md` → `ir-schema`
  //    (only for known source names, so `RUN.md`, `answer.md`, etc. are untouched).
  body = body.replace(/`([a-z0-9-]+)\.md`/g, (m, name) => (SOURCE_NAMES.has(name) ? `\`${name}\`` : m));

  // 4. Pin heading ids where an in-page anchor link needs them.
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
  const page = `${frontmatter}\n\n${banner}\n\n${transform(key, src)}`;
  writeFileSync(resolve(outDir, `${out}.md`), page.endsWith('\n') ? page : `${page}\n`);
  count += 1;
}
console.log(`gen-reference: wrote ${count} generated page(s) (docs/reference/, docs/community/roadmap.md)`);
