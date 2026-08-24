#!/usr/bin/env node
// Generate the machine-readable documentation index served at /llms.txt.
//
// Every docs page already carries the title and description an agent needs, so
// this script derives the index from that frontmatter instead of maintaining a
// second hand-authored catalog. Root-relative URLs keep the file valid wherever
// the Docusaurus site is hosted.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SITE = resolve(here, '..');
const DOCS_DIR = resolve(SITE, 'docs');
const OUTPUT = resolve(SITE, 'static/llms.txt');

const SECTIONS = [
  {
    directory: 'getting-started',
    title: 'Getting Started',
    order: ['introduction', 'installation', 'quickstart', 'first-profile'],
  },
  {
    directory: 'concepts',
    title: 'Concepts',
    order: [
      'how-warble-works',
      'profiles',
      'components',
      'context-binding',
      'ir',
      'tiers-and-model-binding',
      'capabilities-and-guardrails',
      'blast-radius',
      'render-contract',
      'targets-and-wall-hits',
    ],
  },
  {
    directory: 'guides',
    title: 'Guides',
    order: [
      'authoring-a-profile',
      'writing-a-component',
      'binding-context',
      'mounting-components',
      'dispatching',
      'rendering',
      'hybrid-inference',
      'evaluating',
      'enforcing-mutations',
    ],
  },
  {
    directory: 'reference',
    title: 'Reference',
    order: [
      'cli',
      'profile-schema',
      'ir-schema',
      'capability-model',
      'blast-radius',
      'binding-spec',
      'provider-fragment',
      'enforcement-seam',
      'glossary',
    ],
  },
  {
    directory: 'community',
    title: 'Community',
    order: ['contributing', 'roadmap', 'adding-a-backend'],
  },
];

function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed);
  if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function parsePage(path) {
  const source = readFileSync(path, 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!frontmatter) throw new Error(`${relative(SITE, path)} has no frontmatter`);

  const field = (name) => {
    const match = frontmatter[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'));
    return match ? parseScalar(match[1]) : undefined;
  };

  const title = field('title');
  const description = field('description');
  if (!title || !description) {
    throw new Error(`${relative(SITE, path)} must define title and description`);
  }

  const relativePath = relative(DOCS_DIR, path).split(sep).join('/');
  const slug = field('slug');
  return {
    title,
    description,
    directory: relativePath.split('/')[0],
    basename: relativePath.split('/').at(-1).replace(/\.md$/, ''),
    route: slug || `/${relativePath.replace(/\.md$/, '')}`,
  };
}

const pages = markdownFiles(DOCS_DIR).map(parsePage);
const knownSections = new Set(SECTIONS.map(({ directory }) => directory));
const unknownSections = [...new Set(pages.map(({ directory }) => directory))].filter(
  (directory) => !knownSections.has(directory),
);
if (unknownSections.length > 0) {
  throw new Error(`add llms.txt section metadata for: ${unknownSections.join(', ')}`);
}

const lines = [
  '# Warble',
  '',
  '> Warble is a data behavior framework: declare what a data agent should do, compile it to a language-neutral IR, and dispatch it as a native agent for a runtime.',
  '',
  'Use the Reference section for the authoritative profile, IR, capability, binding, and enforcement contracts. The other sections explain concepts and show end-to-end workflows.',
];

for (const section of SECTIONS) {
  const rank = new Map(section.order.map((name, index) => [name, index]));
  const sectionPages = pages
    .filter(({ directory }) => directory === section.directory)
    .sort((left, right) => {
      const leftRank = rank.get(left.basename) ?? Number.MAX_SAFE_INTEGER;
      const rightRank = rank.get(right.basename) ?? Number.MAX_SAFE_INTEGER;
      return leftRank - rightRank || left.title.localeCompare(right.title);
    });

  lines.push('', `## ${section.title}`, '');
  for (const page of sectionPages) {
    lines.push(`- [${page.title}](${page.route}): ${page.description}`);
  }
}

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, `${lines.join('\n')}\n`);
console.log(`gen-llms: wrote ${pages.length} page(s) to ${relative(SITE, OUTPUT)}`);
