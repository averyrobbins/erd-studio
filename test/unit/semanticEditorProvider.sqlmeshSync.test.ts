import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SqlmeshProjectAdapter, snapshotIntegrity } from '../../src/services/sqlmeshAdapter';

// The launch resolves `claude` on PATH; CI has no Claude Code, so the lookup is
// stubbed while the environment assembly stays real.
vi.mock('../../src/services/assistantLaunch', async (importActual) => ({
  ...(await importActual<typeof import('../../src/services/assistantLaunch')>()),
  resolveExecutable: (name: string) => (name === 'claude' ? '/opt/claude/bin/claude' : undefined),
}));

const repo = path.resolve(__dirname, '../..');
let root: string;
let panel: ReturnType<typeof vscode.createMockWebviewPanel>;
let models: LogicalModelService;
let provider: SemanticEditorProvider;
let edits: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-native-editor-'));
  fs.cpSync(path.join(repo, 'test/fixtures/sqlmesh-project'), root, { recursive: true });
  const file = path.join(root, '.erd-studio/logical-models/fct_order.yml');
  fs.writeFileSync(file, '# Keep this comment\n' + fs.readFileSync(file, 'utf8').replace('dataType: DECIMAL(10, 2)', 'dataType: TEXT\n    scdType: 2'));
  vscode._resetMockWorkspace();
  const layers = new LayerService(root);
  const domains = new DomainService(layers);
  models = new LogicalModelService(root); domains.setLogicalModelService(models);
  const selectors = new SelectorsService(domains, root);
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => {});
  const context = { extensionUri: vscode.Uri.file(repo), globalState: { get: () => true, update: async () => {} }, subscriptions: [] } as any;
  provider = new SemanticEditorProvider(context, domains, new ManifestService(), new YmlParserService(), new TemplateService(), layers, root, selectors, models);
  provider.setProjectAdapter(new SqlmeshProjectAdapter(root));
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, '.erd-studio/silver/orders.json')));
  panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as any, panel as any, {} as any);
  await panel._simulateMessage({ type: 'ready' });
  edits = vi.spyOn(vscode.workspace, 'applyEdit');
});
afterEach(() => { panel.dispose(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const error = () => (panel._postedMessages as any[]).filter(m => m.type === 'error').at(-1)?.payload.message;

it('recomputes an open comparison after a logical column edit', async () => {
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
  const report = () => (panel._postedMessages as any[]).filter(m => m.type === 'discrepancyReport').at(-1)?.payload;
  expect(report().summary.dataTypeMismatches).toBe(1);
  await panel._simulateMessage({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'amount', column: { name: 'amount', dataType: 'DECIMAL(10, 2)' } } });
  expect(error()).toBeUndefined();
  expect(report().summary.dataTypeMismatches).toBe(0);
});

it('clears a failed background comparison without reporting a logical edit as failed', async () => {
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
  fs.rmSync(path.join(root, '.erd-studio/sqlmesh.json'));
  await panel._simulateMessage({ type: 'updateModelGrain', payload: { modelName: 'fct_order', grain: 'Still editable without metadata' } });
  expect(error()).toBeUndefined();
  expect(models.getModel('fct_order')!.grain).toBe('Still editable without metadata');
  expect((panel._postedMessages as any[]).filter(m => m.type === 'discrepancyReport').at(-1).payload).toBeNull();
});

it.each(['logical', 'physical'] as const)('opens the bound model source from %s without modifying files', async stage => {
  if (stage === 'physical') await panel._simulateMessage({ type: 'switchStage', payload: { stage } });
  const open = vi.spyOn(vscode.window, 'showTextDocument');
  const before = edits.mock.calls.length;
  await panel._simulateMessage({ type: 'openModelSource', payload: { modelName: 'fct_order', path: '/unrelated/file' } });
  expect(error()).toBeUndefined();
  expect((open.mock.calls.at(-1)![0] as vscode.Uri).fsPath).toBe(path.join(root, 'models/fct_order.sql'));
  expect(edits.mock.calls.length).toBe(before);
});

it('rejects an import with colliding identifiers before creating a logical model', async () => {
  const file = path.join(root, '.erd-studio/sqlmesh.json');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.models.push({ ...snapshot.models[0], name: 'collision', id: '"memory"."analytics"."collision"',
    identifierFolding: 'upper', columns: [{ name: 'ID', dataType: 'INT', description: '' }, { name: 'id', dataType: 'TEXT', description: '' }], uniqueKeys: [] });
  snapshot.integrity = snapshotIntegrity(snapshot);
  fs.writeFileSync(file, JSON.stringify(snapshot));
  await provider.refreshAllOpenDomains();
  const before = edits.mock.calls.length;
  await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'collision' } });
  expect(error()).toContain('collide');
  expect(edits.mock.calls.length).toBe(before);
  expect(fs.existsSync(path.join(root, '.erd-studio/logical-models/collision.yml'))).toBe(false);
});
async function prepare(stage: 'logical' | 'physical' = 'logical', truth = 'physical') {
  if (stage === 'physical') await panel._simulateMessage({ type: 'switchStage', payload: { stage } });
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: stage === 'logical' ? 'physical' : 'logical' } });
  await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: { 'col:fct_order:amount': truth } } });
  expect(error()).toBeUndefined();
  expect((panel._postedMessages as any[]).find(m => m.type === 'syncPlanGenerated')).toBeTruthy();
}
it.each(['logical', 'physical'] as const)('applies one WorkspaceEdit from %s while preserving comments, design fields and undo grouping', async stage => {
  await prepare(stage);
  const before = edits.mock.calls.length;
  await panel._simulateMessage({ type: 'applySqlmeshLogicalSync' });
  expect(error()).toBeUndefined();
  expect(edits.mock.calls.length - before).toBe(1);
  const ops = (edits.mock.calls.at(-1)![0] as any)._ops;
  expect(ops.filter((op: any) => op.kind === 'replace')).toHaveLength(2);
  const text = fs.readFileSync(path.join(root, '.erd-studio/logical-models/fct_order.yml'), 'utf8');
  expect(text).toContain('# Keep this comment');
  expect(text).toContain('scdType: 2');
  expect(text).toContain('One row per order');
  expect(models.getModel('fct_order')!.columns!.find(c => c.name === 'amount')!.dataType).toBe('DECIMAL(10, 2)');
  expect((panel._postedMessages as any[]).some(m => m.type === 'sqlmeshLogicalSyncApplied')).toBe(true);
  await panel._simulateMessage({ type: 'applySqlmeshLogicalSync' });
  expect(error()).toContain('Prepare and review');
  expect(edits.mock.calls.length - before).toBe(1);
});
it.each(['source', 'plan', 'logical'])('rejects a %s change after review without writing', async kind => {
  await prepare();
  const before = edits.mock.calls.length;
  const file = kind === 'source' ? 'models/fct_order.sql' : kind === 'plan' ? '.erd-studio/.sync-plan.json' : '.erd-studio/logical-models/dim_customer.yml';
  fs.appendFileSync(path.join(root, file), '\n');
  await panel._simulateMessage({ type: 'applySqlmeshLogicalSync' });
  expect(error()).toMatch(/changed|stale/);
  expect(edits.mock.calls.length).toBe(before);
});
it('prepares an AI source plan and rejects applying it through the logical writer', async () => {
  await prepare('logical', 'logical');
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/.sync-plan.json'), 'utf8'));
  expect(saved.direction).toBe('logical-to-source');
  expect(saved.modelContext.fct_order.sourcePath).toBe('models/fct_order.sql');
  expect(saved.refreshCommand.args).toEqual([path.join(repo, 'dist/sqlmesh_export.py'), '--project', root, '--semantic-dir', '.erd-studio']);
  expect(saved.instructions.join(' ')).toContain('Do not use the sqlmesh render CLI');
  const before = edits.mock.calls.length;
  await panel._simulateMessage({ type: 'applySqlmeshLogicalSync' });
  expect(error()).toContain('assisted source edits');
  expect(edits.mock.calls.length).toBe(before);
});

it('launches native source guidance only after a current plan is reviewed', async () => {
  await prepare('logical', 'logical');
  (vscode.workspace as any).isTrusted = true;
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Launch' as any);
  const launch = vi.spyOn(vscode.window, 'createTerminal');
  // A project venv: the assistant must see it first on PATH, as a shell activation would arrange.
  fs.mkdirSync(path.join(root, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'home = /usr/bin\n');
  try {
    await panel._simulateMessage({ type: 'launchClaudeSync' });
    expect(error()).toBeUndefined();
    const options = launch.mock.calls.at(-1)![0] as any;
    expect(options.shellPath).toBe('/opt/claude/bin/claude');
    expect(options.shellArgs).toHaveLength(1);
    expect(options.shellArgs[0]).toContain('verify the SHA-256 hashes');
    expect(options.shellArgs[0]).toContain('never deploy');
    expect(options.shellArgs[0]).not.toContain('dbt compile');
    expect(options.env.PATH.split(path.delimiter)[0]).toBe(path.join(root, '.venv', 'bin'));
    expect(options.env.VIRTUAL_ENV).toBe(path.join(root, '.venv'));
    const terminal = vscode.window.terminals.at(-1)!;
    expect(terminal._sentText).toEqual([]);
    terminal.dispose();
  } finally {
    (vscode.workspace as any).isTrusted = false;
  }
});

it('refuses a shared-column removal that would break another domain relationship', async () => {
  const artifact = path.join(root, '.erd-studio/sqlmesh.json');
  const snapshot = JSON.parse(fs.readFileSync(artifact, 'utf8'));
  snapshot.models.find((m: any) => m.name === 'fct_order').columns = snapshot.models.find((m: any) => m.name === 'fct_order').columns.filter((c: any) => c.name !== 'amount');
  delete snapshot.integrity; // as an exporter from before the stamp would have written it
  fs.writeFileSync(artifact, JSON.stringify(snapshot));
  const other = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/silver/orders.json'), 'utf8'));
  other.domain = 'other';
  other.logical.relationships = [{ fromModel: 'fct_order', fromColumn: 'amount', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' }];
  fs.writeFileSync(path.join(root, '.erd-studio/silver/other.json'), JSON.stringify(other));
  await provider.refreshAllOpenDomains();
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
  const before = edits.mock.calls.length;
  await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: { 'col:fct_order:amount': 'physical' } } });
  expect(error()).toContain('referenced by a relationship in other');
  expect(edits.mock.calls.length).toBe(before);
});

it('imports explicitly bound case siblings through the editor with native hints in both stages', async () => {
  const file = path.join(root, '.erd-studio/sqlmesh.json');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  snapshot.models.push({ ...snapshot.models[0], name: 'bound', id: '"memory"."analytics"."bound"',
    identifierFolding: 'upper', columns: [{ name: 'ID', dataType: 'INT', description: '' }, { name: 'id', dataType: 'TEXT', description: '' }],
    uniqueKeys: [], columnBindings: { native_id: 'ID', quoted_id: 'id' } });
  snapshot.integrity = snapshotIntegrity(snapshot);
  fs.writeFileSync(file, JSON.stringify(snapshot));
  await provider.refreshAllOpenDomains();
  await panel._simulateMessage({ type: 'addExistingModel', payload: { modelName: 'bound' } });
  expect(error()).toBeUndefined();
  expect(models.getModel('bound')!.columns!.map(c => c.name)).toEqual(['native_id', 'quoted_id']);
  const lastDomain = () => (panel._postedMessages as any[]).filter(m => m.type === 'domainLoaded').at(-1).payload;
  expect(lastDomain().models.find((m: any) => m.name === 'bound').columns.map((c: any) => c.nativeName)).toEqual(['ID', 'id']);
  await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
  expect(error()).toBeUndefined();
  const switched = (panel._postedMessages as any[]).filter(m => m.type === 'stageData').at(-1);
  expect(JSON.stringify(switched)).toContain('"nativeName":"ID"');
});
