// Synthetic, explicitly selected host adapter. No database, credentials or discovery.
export async function loadProject(project) {
  if (!['demo', 'other'].includes(project)) throw new Error('unknown_project');
  return {
    metadata: [
      { kind: 'schema.structure', document: 'catalog', value: { models: ['orders'] } },
      { kind: 'knowledge.rules', document: 'rules', value: { rule: 'Revenue excludes refunds.' } },
      { kind: 'data.raw', document: 'rows', value: { secret: 'PRIVATE_RAW_CANARY' } },
    ],
    children: { callee: {
      context: [{ kind: 'data.raw', document: 'private-context', value: { project, secret: 'PRIVATE_CONTEXT_CANARY' } }],
      tools: [],
      projection: {
        project: raw => ({ count: raw.count }),
        validate: value => Number.isSafeInteger(value.count) && value.count >= 0 && value.count <= 10000,
      },
    } },
  };
}
