import { z } from 'zod';
import { buildServices } from '../services.js';
import { SqlmeshProjectAdapter } from '../../../src/services/sqlmeshAdapter.js';

export const list_project_models = {
  name: 'list_project_models',
  config: {
    title: 'List project models (dbt or SQLMesh)',
    description: 'Read project model columns, relationships and provenance. SQLMesh uses a saved metadata export, never executes Python, and reports missing/stale exports. Inferred types are not warehouse observations.',
    inputSchema: { project_path: z.string().describe('Absolute project root'), name_contains: z.string().optional(), provider: z.enum(['auto', 'dbt', 'sqlmesh']).optional() },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async handler({ project_path, name_contains, provider }: { project_path: string; name_contains?: string; provider?: 'auto' | 'dbt' | 'sqlmesh' }) {
    const { projectAdapter } = buildServices(project_path, provider);
    const data = await projectAdapter.load();
    const names = new Set([...data.manifest.models.keys(), ...data.declarations.models.keys(), ...(data.catalog?.byName.values() ?? [])].map(v => typeof v === 'string' ? v : v.name));
    const mesh = projectAdapter instanceof SqlmeshProjectAdapter ? projectAdapter : undefined;
    const ready = !mesh || mesh.generatedAt;
    const physical = ready ? projectAdapter.buildPhysical({ schemaVersion: 5, domain: 'project', layer: 'silver', description: '',
      logical: { models: [...names].map(name => ({ name, columns: [] })), relationships: [] }, viewConfig: {} }, data) : undefined;
    const filter = name_contains?.toLowerCase();
    const models = (physical?.models ?? []).filter(m => !filter || m.name.toLowerCase().includes(filter) || m.qualifiedName?.toLowerCase().includes(filter));
    return { content: [{ type: 'text' as const, text: JSON.stringify({ provider: projectAdapter.provider,
      ...(mesh ? { ...mesh.integration } : {}),
      count: models.length, total: names.size, models, relationships: physical?.relationships ?? [] }, null, 2) }] };
  },
};
