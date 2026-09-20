/**
 * The host's `activeStage` must describe what the webview is actually showing.
 *
 * The webview changes stage only when a `stageData` reply arrives, so a switch
 * whose payload cannot be built (a SQLMesh project with no export yet is the
 * everyday case) has to leave the host where it was. Before this guard the host
 * flipped to `physical` first, the build threw, and every later edit on the
 * still-logical canvas was refused as "Physical stage is read-only" — with no
 * tab click able to undo it, because the webview believed it was on logical.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SqlmeshProjectAdapter } from '../../src/services/sqlmeshAdapter';

const repo = path.resolve(__dirname, '../..');
let root: string;
let panel: ReturnType<typeof vscode.createMockWebviewPanel>;
let provider: SemanticEditorProvider;
let adapter: SqlmeshProjectAdapter;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-stage-switch-'));
  fs.cpSync(path.join(repo, 'test/fixtures/sqlmesh-project'), root, { recursive: true });
  vscode._resetMockWorkspace();
  const layers = new LayerService(root);
  const domains = new DomainService(layers);
  const models = new LogicalModelService(root);
  domains.setLogicalModelService(models);
  const selectors = new SelectorsService(domains, root);
  vi.spyOn(selectors, 'scheduleRegenerate').mockImplementation(() => {});
  const context = { extensionUri: vscode.Uri.file(repo), globalState: { get: () => true, update: async () => {} }, subscriptions: [] } as any;
  provider = new SemanticEditorProvider(context, domains, new ManifestService(), new YmlParserService(), new TemplateService(), layers, root, selectors, models);
  adapter = new SqlmeshProjectAdapter(root);
  provider.setProjectAdapter(adapter);
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, '.erd-studio/silver/orders.json')));
  panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as any, panel as any, {} as any);
  await panel._simulateMessage({ type: 'ready' });
});

afterEach(() => {
  panel.dispose();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const posted = () => panel._postedMessages as Array<{ type: string; payload?: any; requestId?: number }>;
const lastError = () => posted().filter(m => m.type === 'error').at(-1)?.payload?.message as string | undefined;

it('stays on the logical stage when the physical payload cannot be built, so edits still apply', async () => {
  fs.unlinkSync(path.join(root, '.erd-studio/sqlmesh.json'));
  adapter.invalidate();
  const before = posted().length;

  await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });

  expect(lastError()).toContain('No SQLMesh export found');
  expect(posted().slice(before).some(m => m.type === 'stageData')).toBe(false);

  // The canvas still shows logical, so a logical edit must go through — not be
  // refused by the physical-stage guard.
  const edits = vi.spyOn(vscode.workspace, 'applyEdit');
  await panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'fct_order', description: 'Orders, one row each' } });
  expect(lastError()).not.toContain('read-only');
  expect(edits).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(root, '.erd-studio/logical-models/fct_order.yml'), 'utf8')).toContain('Orders, one row each');
});

it('commits the stage and replies once the payload exists', async () => {
  await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
  const reply = posted().filter(m => m.type === 'stageData').at(-1)!;
  expect(reply.requestId).toBe(1);
  expect(reply.payload.stage).toBe('physical');

  // Now the guard is legitimately active.
  await panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'fct_order', description: 'nope' } });
  expect(lastError()).toContain('read-only');
});

it('drops a switch that a newer switch for the same panel overtook', async () => {
  // Make the first (physical) build slow: its metadata load resolves only
  // after the second (logical) switch has completed.
  const realLoad = adapter.load.bind(adapter);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(adapter, 'load').mockImplementationOnce(async () => { await gate; return realLoad(); });

  const slow = panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
  await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'logical', requestId: 2 } });
  release();
  await slow;

  const replies = posted().filter(m => m.type === 'stageData').map(m => m.requestId);
  expect(replies).toEqual([2]);
  expect(lastError()).toBeUndefined();

  // Host agrees with the webview: still logical, so edits apply.
  const edits = vi.spyOn(vscode.workspace, 'applyEdit');
  await panel._simulateMessage({ type: 'updateModelDescription', payload: { modelName: 'fct_order', description: 'still editable' } });
  expect(lastError()).toBeUndefined();
  expect(edits).toHaveBeenCalledTimes(1);
});
