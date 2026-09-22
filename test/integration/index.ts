/** Real VS Code APIs + the production React webview. A test-only bridge drives
 * the same messages as UI controls; it never ships in the extension bundle. */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as assert from 'node:assert/strict';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SqlmeshProjectAdapter } from '../../src/services/sqlmeshAdapter';
import { refreshSqlmesh } from '../../src/services/sqlmeshRefresh';
import { assistantEnvironment, resolveExecutable } from '../../src/services/assistantLaunch';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(description: string, read: () => T | undefined | false): Promise<T> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = read();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`Timed out: ${description}`);
}

async function editor(repo: string, root: string, providerName: string) {
  const layers = new LayerService(root);
  const models = new LogicalModelService(root);
  const domains = new DomainService(layers); domains.setLogicalModelService(models);
  const selectors = new SelectorsService(domains, root, '.erd-studio');
  const manifest = new ManifestService();
  // Only the welcome flag is supplied locally; all editor, document, terminal,
  // command, webview, undo and WorkspaceEdit operations use the real VS Code API.
  const context = { extensionUri: vscode.Uri.file(repo), subscriptions: [],
    globalState: { get: () => true, update: async () => {} } } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(context, domains, manifest, new YmlParserService(), new TemplateService(), layers, root, selectors, models);
  const adapter = providerName === 'sqlmesh' ? new SqlmeshProjectAdapter(root) : undefined;
  if (adapter) provider.setProjectAdapter(adapter);
  const relative = providerName === 'sqlmesh' ? '.erd-studio/silver/orders.json' : '.erd-studio/silver/showcase.json';
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, relative)));
  const panel = vscode.window.createWebviewPanel('erdHostTest', 'ERD Studio integration check', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  const replies: any[] = [];
  const subscription = panel.webview.onDidReceiveMessage(message => {
    if (message.type === 'erdHostTestReply') replies.push(message.message);
  });
  // Test observation packets must not enter the application's mutation guard.
  // Every application packet still travels through the real webview transport.
  const appWebview = new Proxy(panel.webview, { get(target, key) {
    if (key === 'onDidReceiveMessage') return (listener: (message: any) => void) =>
      target.onDidReceiveMessage(message => { if (message.type !== 'erdHostTestReply') listener(message); });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }, set: (target, key, value) => Reflect.set(target, key, value, target) });
  const appPanel = new Proxy(panel, { get(target, key) {
    if (key === 'webview') return appWebview;
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }, set: (target, key, value) => Reflect.set(target, key, value, target) });
  const cancellation = new vscode.CancellationTokenSource();
  await provider.resolveCustomTextEditor(doc, appPanel, cancellation.token);
  const html = panel.webview.html;
  const nonce = html.match(/<script nonce="([^"]+)"/)?.[1];
  assert.ok(nonce, 'production webview has a nonce');
  const bridge = `<script nonce="${nonce}">
    const originalApi = window.acquireVsCodeApi; let testApi;
    window.acquireVsCodeApi = () => (testApi = originalApi());
    window.addEventListener('message', ({data}) => {
      if (!testApi) return;
      if (data.type === 'erdHostTestSend') testApi.postMessage(data.message);
      else if (data.type === 'erdHostTestDom') testApi.postMessage({type:'erdHostTestReply',message:{type:'dom',text:document.body.innerText}});
      else testApi.postMessage({type:'erdHostTestReply',message:data});
    });
  </script>`;
  panel.webview.html = html.replace(/<script nonce=/, `${bridge}<script nonce=`);
  await until('production React webview ready', () => replies.find(m => m.type === 'domainLoaded'));
  async function send(message: unknown, expected: string) {
    const start = replies.length;
    assert.ok(await panel.webview.postMessage({ type: 'erdHostTestSend', message }));
    return until(`reply ${expected}`, () => {
      const arrived = replies.slice(start);
      const error = arrived.find(m => m.type === 'error');
      if (error && expected !== 'error') throw new Error(error.payload.message);
      return arrived.find(m => m.type === expected);
    });
  }
  return { provider, adapter, doc, panel, models, send, replies,
    dispose() { subscription.dispose(); panel.dispose(); cancellation.dispose(); } };
}

export async function run(): Promise<void> {
  const repo = process.env.ERD_HOST_TEST_REPO!;
  const temp = process.env.ERD_HOST_TEST_ROOT!;
  const kind = process.env.ERD_HOST_TEST_PROVIDER!;
  const python = process.env.ERD_HOST_TEST_PYTHON!;
  const root = path.join(temp, 'project');
  const checks: string[] = [];
  let active: Awaited<ReturnType<typeof editor>> | undefined;
  try {
    if (kind === 'sqlmesh') {
      assert.equal(fs.existsSync(path.join(root, '.erd-studio/sqlmesh.json')), false);
      // Invoke the contributed command, exercising implicit activation for a
      // fresh native project and the real packaged exporter subprocess.
      await vscode.commands.executeCommand('erdStudio.refreshManifest');
      const exported = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/sqlmesh.json'), 'utf8'));
      assert.equal(exported.provider, 'sqlmesh');
      assert.ok(vscode.extensions.getExtension('liamwynne.erd-studio')?.isActive);
      checks.push('native command activation and Python refresh');
      const modelFile = path.join(root, '.erd-studio/logical-models/fct_order.yml');
      fs.writeFileSync(modelFile, '# Preserve comment\n' + fs.readFileSync(modelFile, 'utf8').replace('dataType: DECIMAL(10, 2)', 'dataType: TEXT\n    scdType: 2'));
    } else {
      await vscode.extensions.getExtension('liamwynne.erd-studio')!.activate();
      checks.push('dbt extension activation');
    }
    active = await editor(repo, root, kind);
    const physical = await active.send({ type: 'switchStage', payload: { stage: 'physical' } }, 'stageData');
    assert.equal(physical.payload.stage, 'physical');
    assert.ok(physical.payload.models.length >= 2);
    await active.send({ type: 'switchStage', payload: { stage: 'logical' } }, 'stageData');
    const comparison = await active.send({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } }, 'discrepancyReport');
    assert.ok(comparison.payload.models.length >= 2);
    checks.push('production webview messaging, both stages and comparison');

    if (kind === 'sqlmesh') {
      assert.ok(await active.panel.webview.postMessage({ type: 'erdHostTestSend', message: { type: 'openModelSource', payload: { modelName: 'fct_order' } } }));
      await until('source navigation', () => vscode.window.activeTextEditor?.document.uri.fsPath === path.join(root, 'models/fct_order.sql'));
      checks.push('opens the exported model source in a real text editor');
      const modelFile = path.join(root, '.erd-studio/logical-models/fct_order.yml');
      const originalModel = fs.readFileSync(modelFile, 'utf8');
      await active.send({ type: 'generateSyncPlan', payload: { selections: { 'col:fct_order:amount': 'physical' } } }, 'syncPlanGenerated');
      await active.send({ type: 'applySqlmeshLogicalSync' }, 'sqlmeshLogicalSyncApplied');
      const applied = fs.readFileSync(modelFile, 'utf8');
      assert.match(applied, /DECIMAL\(10, 2\)/);
      assert.match(applied, /# Preserve comment/);
      assert.match(applied, /scdType: 2/);
      // Focus the domain document so VS Code routes native undo to the shared
      // edit stack. This checks real grouped file edits, beyond mock op counts.
      await vscode.window.showTextDocument(active.doc);
      const beforeUndo = active.replies.length;
      await active.send({ type: 'undo' }, 'domainLoaded');
      assert.equal(fs.readFileSync(modelFile, 'utf8'), originalModel);
      await until('comparison reflects grouped undo', () => active!.replies.slice(beforeUndo)
        .find(m => m.type === 'discrepancyReport' && m.payload?.summary.dataTypeMismatches === 1));
      checks.push('logical sync preserves annotations and native grouped undo restores YAML');
      await active.send({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } }, 'discrepancyReport');
      await active.send({ type: 'generateSyncPlan', payload: { selections: { 'col:fct_order:amount': 'logical' } } }, 'syncPlanGenerated');
      const plan = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/.sync-plan.json'), 'utf8'));
      assert.equal(plan.direction, 'logical-to-source');
      assert.equal(plan.modelContext.fct_order.sourcePath, 'models/fct_order.sql');
      fs.appendFileSync(path.join(root, 'models/fct_order.sql'), '\n-- changed after review\n');
      const rejected = await active.send({ type: 'launchClaudeSync' }, 'error');
      assert.match(rejected.payload.message, /stale|changed/);
      checks.push('source plan and stale-input rejection before assistant launch');

      const previous = fs.readFileSync(path.join(root, '.erd-studio/sqlmesh.json'));
      const slow = path.join(temp, 'slow_export.py');
      fs.writeFileSync(slow, 'import time\ntime.sleep(30)\n');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 200);
      await assert.rejects(refreshSqlmesh({ root, semanticDir: '.erd-studio', exporter: slow, python, signal: controller.signal }), /cancelled/);
      clearTimeout(timer);
      assert.deepEqual(fs.readFileSync(path.join(root, '.erd-studio/sqlmesh.json')), previous);
      checks.push('real exporter subprocess cancellation preserves the prior snapshot');

      // An inert CLI probe verifies real terminal argv, cwd and environment.
      // It performs no AI request and does not edit the SQLMesh project.
      const probe = path.join(temp, 'terminal-probe.cjs');
      const output = path.join(temp, 'terminal-result.json');
      fs.writeFileSync(probe, `require('fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify({cwd:process.cwd(),argv:process.argv.slice(2),path:process.env.PATH}));`);
      const executable = resolveExecutable('node');
      assert.ok(executable);
      const prompt = 'Review a plan with spaces; $literal and "quoted text"';
      const terminal = vscode.window.createTerminal({ name: 'ERD isolated CLI probe', cwd: root, shellPath: executable,
        shellArgs: [probe, prompt], env: assistantEnvironment({ workspaceRoot: root, pythonPath: python }) });
      try {
        await until('terminal probe', () => fs.existsSync(output));
        const result = JSON.parse(fs.readFileSync(output, 'utf8'));
        assert.equal(result.cwd, root);
        assert.deepEqual(result.argv, [prompt]);
        assert.equal(result.path.split(path.delimiter)[0], path.dirname(python));
      } finally { terminal.dispose(); }
      checks.push('real terminal preserves prompt argument, cwd and selected Python PATH');

      const settings = vscode.workspace.getConfiguration('erdStudio');
      const previousAuto = settings.inspect<boolean>('sqlmesh.autoRefresh')?.globalValue;
      try {
        await settings.update('sqlmesh.autoRefresh', true, vscode.ConfigurationTarget.Global);
        const input = path.join(root, 'models/fct_order.sql');
        fs.appendFileSync(input, '\n-- automatic refresh acceptance\n');
        const hash = (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(input)).digest('hex');
        await until('automatic source refresh through the registered extension watcher', () => {
          const snapshot = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/sqlmesh.json'), 'utf8'));
          return snapshot.inputs['models/fct_order.sql'] === hash;
        });
      } finally {
        await settings.update('sqlmesh.autoRefresh', previousAuto, vscode.ConfigurationTarget.Global);
      }
      checks.push('opt-in automatic metadata refresh observes source saves without a manual command');

      const beforeTuple = fs.readFileSync(active.doc.uri.fsPath, 'utf8');
      const tuple = { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id',
        cardinality: 'many-to-one', columnPairs: [
          { fromColumn: 'customer_id', toColumn: 'customer_id' }, { fromColumn: 'amount', toColumn: 'name' },
        ] };
      await active.send({ type: 'addRelationship', payload: tuple }, 'domainLoaded');
      assert.deepEqual(JSON.parse(fs.readFileSync(active.doc.uri.fsPath, 'utf8')).logical.relationships.at(-1), tuple);
      await active.send({ type: 'updateColumn', payload: { modelName: 'fct_order', oldColumnName: 'amount',
        column: { name: 'total', dataType: 'TEXT' } } }, 'domainLoaded');
      assert.equal(JSON.parse(fs.readFileSync(active.doc.uri.fsPath, 'utf8')).logical.relationships.at(-1).columnPairs[1].fromColumn, 'total');
      await vscode.window.showTextDocument(active.doc);
      await active.send({ type: 'undo' }, 'domainLoaded');
      assert.deepEqual(JSON.parse(fs.readFileSync(active.doc.uri.fsPath, 'utf8')).logical.relationships.at(-1), tuple);
      assert.match(fs.readFileSync(modelFile, 'utf8'), /name: amount/);
      await active.send({ type: 'undo' }, 'domainLoaded');
      assert.equal(fs.readFileSync(active.doc.uri.fsPath, 'utf8'), beforeTuple);
      checks.push('tuple creation and secondary-column rename use native grouped undo and preserve single edges');

      fs.rmSync(path.join(root, '.erd-studio/sqlmesh.json'));
      const failedSwitch = await active.send({ type: 'switchStage', payload: { stage: 'physical' } }, 'error');
      assert.match(failedSwitch.payload.message, /export|metadata/i);
      await active.send({ type: 'updateModelGrain', payload: { modelName: 'fct_order', grain: 'One row per order; verified in host' } }, 'domainLoaded');
      assert.match(fs.readFileSync(modelFile, 'utf8'), /verified in host/);
      checks.push('failed Physical switch leaves Logical editing available');
    }
    fs.writeFileSync(path.join(temp, 'results.json'), JSON.stringify({ passed: true, vscode: vscode.version, provider: kind, checks }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(temp, 'results.json'), JSON.stringify({ passed: false, vscode: vscode.version, provider: kind, checks, error: error instanceof Error ? error.stack : String(error) }, null, 2));
    throw error;
  } finally {
    active?.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  }
}
