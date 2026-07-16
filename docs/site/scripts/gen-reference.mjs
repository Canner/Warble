#!/usr/bin/env node
// Generate the docs-site Reference pages from the authoritative specs in docs/spec/.
//
// Single source of truth: edit docs/spec/*.md, then re-run `npm run gen:reference`
// (also runs automatically via the `prebuild`/`prestart` hooks). The generated pages
// carry a "do not edit" banner; a stale page shows up as a git diff after regeneration.
//
// `reference/cli.md` is NOT generated here — it has no single spec source (it is authored
// from the clap CLI definition) and is maintained by hand.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..');              // docs/site
const SPEC_DIR = resolve(SITE, '../spec');     // docs/spec
const OUT_DIR = resolve(SITE, 'docs/reference');

// spec basename -> { out: reference page basename, title, description }
const PAGES = {
  authoring: {
    out: 'profile-schema',
    title: 'Profile & component authoring',
    description:
      'How Warble profiles and components are declared — the profile/component/IR layering, context binding, tiers, guardrails, and the render contract.',
  },
  'ir-schema': {
    out: 'ir-schema',
    title: 'IR schema',
    description:
      'The Warble IR compile contract (warble_ir_version 0.3) — the language-neutral seam every back-end consumes.',
  },
  'capability-model': {
    out: 'capability-model',
    title: 'Capability model',
    description:
      "How dispatch resolves each IR-declared capability against a target runtime's capability profile — native, realize-via, degrade, or fail.",
  },
  'blast-radius': {
    out: 'blast-radius',
    title: 'Blast radius',
    description:
      'The as-built blast-radius query over the semantic lineage graph — types, construction, the algorithm, worked examples, and current limitations.',
  },
  'binding-spec': {
    out: 'binding-spec',
    title: 'Tier-to-model binding spec',
    description:
      'The authoritative --models-config tier-to-model binding format (binding_spec_version 1.0) consumed by every back-end.',
  },
  'enforcement-seam': {
    out: 'enforcement-seam',
    title: 'Enforcement seam',
    description:
      'How a dispatched target actually enforces a guardrail at runtime — the four enforcement points and the two enforcement layers.',
  },
  glossary: {
    out: 'glossary',
    title: 'Glossary',
    description: "One-line definitions of Warble's load-bearing terms.",
  },
};

// spec basename -> site route, for rewriting sibling links.
const ROUTE = Object.fromEntries(
  Object.entries(PAGES).map(([spec, { out }]) => [spec, `/reference/${out}`]),
);
ROUTE.roadmap = '/community/roadmap';

// Explicit heading-id pins where an in-page anchor link would not match the auto-slug.
const HEADING_IDS = {
  'ir-schema': [
    { match: /^## Resolution rules \(front-end[^\n]*\)/m, id: 'resolution-rules' },
    { match: /^## v0\.3 — fine-grained context binding/m, id: 'v03--fine-grained-context-binding' },
  ],
};

const SPEC_NAMES = new Set(Object.keys(ROUTE));

function transform(specName, src) {
  let body = src;

  // 1. Drop the leading top-level H1 (frontmatter title replaces it).
  body = body.replace(/^#\s+.*\r?\n/, '');

  // 2. Rewrite markdown links to sibling specs / roadmap → site routes.
  //    Handles optional ./ ../ and docs/spec/ prefixes and an optional #anchor.
  body = body.replace(
    /\]\((?:\.{1,2}\/)*(?:docs\/spec\/)?([a-z0-9-]+)\.md(#[\w-]+)?\)/g,
    (m, name, anchor = '') => (ROUTE[name] ? `](${ROUTE[name]}${anchor || ''})` : m),
  );

  // 3. De-suffix bare inline-code spec mentions: `ir-schema.md` → `ir-schema`
  //    (only for known spec/roadmap names, so `RUN.md`, `answer.md`, etc. are untouched).
  body = body.replace(/`([a-z0-9-]+)\.md`/g, (m, name) => (SPEC_NAMES.has(name) ? `\`${name}\`` : m));

  // 4. Pin heading ids where an in-page anchor link needs them.
  for (const { match, id } of HEADING_IDS[specName] || []) {
    body = body.replace(match, (line) => (line.includes('{#') ? line : `${line} {#${id}}`));
  }

  return body.replace(/^\s+/, '');
}

mkdirSync(OUT_DIR, { recursive: true });
let count = 0;
for (const [specName, { out, title, description }] of Object.entries(PAGES)) {
  const src = readFileSync(resolve(SPEC_DIR, `${specName}.md`), 'utf8');
  const banner = `<!-- @generated from docs/spec/${specName}.md by scripts/gen-reference.mjs — do not edit; edit the spec and re-run \`npm run gen:reference\` -->`;
  const frontmatter = `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---`;
  const page = `${frontmatter}\n\n${banner}\n\n${transform(specName, src)}`;
  writeFileSync(resolve(OUT_DIR, `${out}.md`), page.endsWith('\n') ? page : `${page}\n`);
  count += 1;
}
console.log(`gen-reference: wrote ${count} reference pages from docs/spec/ → docs/reference/`);
