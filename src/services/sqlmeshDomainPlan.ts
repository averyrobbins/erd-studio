import type { SqlmeshSnapshot } from '../types/project';
import type { UnifiedDomain } from '../types/semantic';

export const SQLMESH_CLI = "from sqlmesh.cli.main import cli; cli(prog_name='sqlmesh')";

/** Reviewable native selection. Never translates dbt selectors or applies a plan. */
export function buildSqlmeshDomainPlan(options: {
  root: string; python: string; environment: string; domain: UnifiedDomain; snapshot: SqlmeshSnapshot;
}) {
  const { domain, snapshot, environment } = options;
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(environment)) throw new Error('Use an environment name beginning with a letter and containing only letters, digits or underscores.');
  const modelIds = [...new Set(domain.logical.models.map(logical => {
    const model = snapshot.models.find(m => m.name === logical.name);
    if (!model) throw new Error(`Domain model ${logical.name} has no current SQLMesh binding. Create/bind it and refresh first.`);
    // SQLMesh selectors are a language. Literal identifiers containing selector
    // operators must not accidentally expand this domain to unrelated models.
    if (/[*+&|^()[\]{}]/.test(model.id)) throw new Error(`Model ${logical.name} contains SQLMesh selector operators; select it manually in SQLMesh.`);
    return model.kind === 'EXTERNAL' ? undefined : model.id;
  }).filter((id): id is string => !!id))].sort();
  if (!modelIds.length) throw new Error('The domain has no managed SQLMesh models to plan.');
  const args = ['-c', SQLMESH_CLI, '--paths', options.root];
  if (snapshot.gateway) args.push('--gateway', snapshot.gateway);
  if (snapshot.config) args.push('--config', snapshot.config);
  args.push('plan', environment, ...modelIds.flatMap(id => ['--select-model', id]));
  return { schemaVersion: 1 as const, provider: 'sqlmesh' as const, kind: 'domain-plan' as const,
    domain: domain.domain, layer: domain.layer, environment, modelIds,
    command: { executable: options.python, args },
    notes: [
      'This launches the interactive SQLMesh planner. It can initialize/migrate SQLMesh state; it is separate from source-only metadata refresh and source sync.',
      'Selections limit direct model changes. SQLMesh can include dependencies and affected downstream models outside this domain; review its complete plan and backfill scope.',
      'No auto-apply or no-prompts flags are supplied. SQLMesh asks before applying the plan. External models have no managed deployment and are omitted.',
    ] };
}
