import { z } from 'zod';
import { buildServices } from '../services.js';
import { SqlmeshProjectAdapter } from '../../../src/services/sqlmeshAdapter.js';

export const list_manifest_models = {
  name: 'list_manifest_models',
  config: {
    title: 'List manifest models (legacy)',
    description:
      'Legacy model summary: dbt manifest or saved SQLMesh export, including column counts and ' +
      'declared unique/relationship evidence. Use list_project_models for columns, provenance ' +
      'and SQLMesh export status. A manifest/export alone does not prove deployment or passing tests.',
    inputSchema: {
      project_path: z
        .string()
        .describe('Absolute path to the dbt or SQLMesh project root.'),
      name_contains: z
        .string()
        .optional()
        .describe('Optional. Case-insensitive substring filter on model name (e.g. "dim_" or "fct_").'),
    },
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
    },
  },
  async handler({
    project_path,
    name_contains,
  }: {
    project_path: string;
    name_contains?: string;
  }) {
    const { projectAdapter } = buildServices(project_path);
    const { manifest } = await projectAdapter.load();

    const filter = name_contains?.toLowerCase();
    const allModels = Array.from(manifest.models.entries());
    const matched = filter
      ? allModels.filter(([name]) => name.toLowerCase().includes(filter))
      : allModels;

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              ...(projectAdapter instanceof SqlmeshProjectAdapter ? { provider: 'sqlmesh', status: projectAdapter.status,
                generatedAt: projectAdapter.generatedAt, diagnostics: projectAdapter.diagnostics } : {}),
              count: matched.length,
              total: allModels.length,
              models: matched.map(([name, info]) => ({
                name,
                schema: info.schema ?? null,
                description: info.description ?? null,
                column_count: info.columns?.length ?? 0,
                unique_columns: Array.from(manifest.uniqueColumns.get(name) ?? []),
                relationships: manifest.relationshipTests
                  .filter((t) => t.fromModel === name)
                  .map((t) => ({
                    from_column: t.fromColumn,
                    to_model: t.toModel,
                    to_column: t.toColumn,
                    ...(t.columnPairs ? { column_pairs: t.columnPairs.map(p => ({ from_column: p.fromColumn, to_column: p.toColumn })) } : {}),
                  })),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  },
};
