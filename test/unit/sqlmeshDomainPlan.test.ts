import { expect, it } from 'vitest';
import { buildSqlmeshDomainPlan, SQLMESH_CLI } from '../../src/services/sqlmeshDomainPlan';
import type { SqlmeshSnapshot } from '../../src/types/project';
import type { UnifiedDomain } from '../../src/types/semantic';
import * as fs from 'fs';
import * as path from 'path';

const snapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../fixtures/sqlmesh-project/.erd-studio/sqlmesh.json'), 'utf8')) as SqlmeshSnapshot;
const domain = { schemaVersion: 5, domain: 'orders', layer: 'silver', description: '', viewConfig: {},
  logical: { models: [{ name: 'fct_order' }, { name: 'dim_customer' }], relationships: [] } } as UnifiedDomain;
const options = { root: '/project with spaces', python: '/project with spaces/.venv/bin/python', environment: 'dev', domain, snapshot };

it('plans exact canonical identities with gateway/config and no automatic deployment flags', () => {
  const plan = buildSqlmeshDomainPlan({ ...options, snapshot: { ...snapshot, gateway: 'local', config: 'config_test' } });
  expect(plan.modelIds).toEqual(snapshot.models.filter(m => ['fct_order', 'dim_customer'].includes(m.name)).map(m => m.id).sort());
  expect(plan.command).toEqual({ executable: options.python, args: ['-c', SQLMESH_CLI, '--paths', options.root,
    '--gateway', 'local', '--config', 'config_test', 'plan', 'dev', ...plan.modelIds.flatMap(id => ['--select-model', id])] });
  expect(plan.command.args).not.toContain('--auto-apply');
  expect(plan.command.args).not.toContain('--no-prompts');
  expect(plan.notes.join(' ')).toContain('outside this domain');
});

it('rejects missing model bindings instead of executing a partial domain selection', () => {
  expect(() => buildSqlmeshDomainPlan({ ...options, domain: { ...domain,
    logical: { ...domain.logical, models: [...domain.logical.models, { name: 'unbound' }] } } })).toThrow('unbound');
});

it.each(['dev; command', '--auto-apply', ''])('rejects an invalid environment %s', environment => {
  expect(() => buildSqlmeshDomainPlan({ ...options, environment })).toThrow('environment name');
});

it('does not interpret selector operators embedded in an identifier', () => {
  const changed = structuredClone(snapshot);
  changed.models.find(m => m.name === 'fct_order')!.id = '"db"."analytics"."order*"';
  expect(() => buildSqlmeshDomainPlan({ ...options, snapshot: changed })).toThrow('selector operators');
});

it('omits external models and rejects domains with no managed models', () => {
  const changed = structuredClone(snapshot);
  for (const m of changed.models) m.kind = 'EXTERNAL';
  expect(() => buildSqlmeshDomainPlan({ ...options, snapshot: changed })).toThrow('no managed');
});
