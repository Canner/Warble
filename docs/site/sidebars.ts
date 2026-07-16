import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docs: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'getting-started/introduction',
        'getting-started/installation',
        'getting-started/quickstart',
        'getting-started/first-profile',
      ],
    },
    {
      type: 'category',
      label: 'Concepts',
      collapsed: false,
      items: [
        'concepts/how-warble-works',
        'concepts/profiles',
        'concepts/components',
        'concepts/context-binding',
        'concepts/ir',
        'concepts/tiers-and-model-binding',
        'concepts/capabilities-and-guardrails',
        'concepts/blast-radius',
        'concepts/render-contract',
        'concepts/targets-and-wall-hits',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: true,
      items: [
        'guides/authoring-a-profile',
        'guides/writing-a-component',
        'guides/binding-context',
        'guides/mounting-components',
        'guides/dispatching',
        'guides/rendering',
        'guides/hybrid-inference',
        'guides/evaluating',
        'guides/enforcing-mutations',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: true,
      items: [
        'reference/cli',
        'reference/profile-schema',
        'reference/ir-schema',
        'reference/capability-model',
        'reference/blast-radius',
        'reference/binding-spec',
        'reference/enforcement-seam',
        'reference/glossary',
      ],
    },
    {
      type: 'category',
      label: 'Community',
      collapsed: true,
      items: [
        'community/contributing',
        'community/roadmap',
        'community/adding-a-backend',
        'community/ai-resources',
      ],
    },
  ],
};

export default sidebars;
