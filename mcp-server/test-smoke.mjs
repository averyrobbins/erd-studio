#!/usr/bin/env node
// Quick smoke test — spawn the server, run a few JSON-RPC calls, print results.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_PATH = path.resolve(__dirname, '../test/fixtures/dbt-project');
const SQLMESH_PATH = path.resolve(__dirname, '../test/fixtures/sqlmesh-project');
const BOUND_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mcp-bindings-'));
fs.cpSync(SQLMESH_PATH, BOUND_PATH, { recursive: true });
const boundFile = path.join(BOUND_PATH, '.erd-studio/sqlmesh.json');
const bound = JSON.parse(fs.readFileSync(boundFile, 'utf8'));
// Exercise the optional field through the backwards-compatible unstamped reader.
delete bound.integrity;
bound.models.find(m => m.name === 'fct_order').columnBindings = { customer_key: 'customer_id' };
bound.pendingModels = [{ name: 'new_model', id: '"analytics"."new_model"', dialect: 'duckdb' }];
fs.writeFileSync(boundFile, JSON.stringify(bound));
const SERVER = path.resolve(__dirname, 'dist/index.js');

// Build a temporary "uninitialized" project — has dbt_project.yml but no .erd-studio/
const UNINIT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-mcp-uninit-'));
fs.writeFileSync(path.join(UNINIT_PATH, 'dbt_project.yml'), "name: 'test_uninit'\nversion: '1.0.0'\n");

const child = spawn('node', [SERVER], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
// Set when any check prints ❌ so CI gets a non-zero exit code.
let failed = false;

function fail(message) {
  failed = true;
  console.log(`❌ ${message}`);
}

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // notification or partial
    }
  }
});

function rpc(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function summarize(label, msg) {
  if (msg.error) {
    fail(`${label}: ${JSON.stringify(msg.error)}`);
    return false;
  }
  const text = msg.result?.content?.[0]?.text;
  if (text) {
    const parsed = JSON.parse(text);
    console.log(`✅ ${label}`);
    console.log(JSON.stringify(parsed, null, 2).split('\n').slice(0, 15).join('\n'));
    console.log('...');
  } else if (msg.result?.tools) {
    console.log(`✅ ${label}: ${msg.result.tools.length} tools`);
    for (const t of msg.result.tools) console.log(`   • ${t.name}`);
  } else {
    console.log(`✅ ${label}:`, Object.keys(msg.result || {}).join(','));
  }
  return true;
}

async function main() {
  // 1. Initialize
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '0.1.0' },
  });
  summarize('initialize', init);
  notify('notifications/initialized', {});

  // 2. List tools
  const list = await rpc('tools/list', {});
  summarize('tools/list', list);

  // 3. Call list_domains
  console.log('\n--- list_domains ---');
  const ld = await rpc('tools/call', {
    name: 'list_domains',
    arguments: { project_path: PROJECT_PATH },
  });
  summarize('list_domains', ld);

  // 4. Call read_domain for showcase
  console.log('\n--- read_domain showcase ---');
  const rd = await rpc('tools/call', {
    name: 'read_domain',
    arguments: { project_path: PROJECT_PATH, layer: 'silver', domain: 'showcase' },
  });
  summarize('read_domain', rd);

  // 5. Call list_models
  console.log('\n--- list_models ---');
  const lm = await rpc('tools/call', {
    name: 'list_models',
    arguments: { project_path: PROJECT_PATH },
  });
  summarize('list_models', lm);

  // 6. Call read_model
  console.log('\n--- read_model dim_customer ---');
  const rm = await rpc('tools/call', {
    name: 'read_model',
    arguments: { project_path: PROJECT_PATH, model_name: 'dim_customer' },
  });
  summarize('read_model', rm);

  // 7. Call list_manifest_models
  console.log('\n--- list_manifest_models ---');
  const lmm = await rpc('tools/call', {
    name: 'list_manifest_models',
    arguments: { project_path: PROJECT_PATH, name_contains: 'dim' },
  });
  summarize('list_manifest_models', lmm);

  // Native reads need no SQLMesh/Python process and retain metadata provenance.
  const native = await rpc('tools/call', {
    name: 'list_project_models', arguments: { project_path: SQLMESH_PATH },
  });
  const mesh = JSON.parse(native.result?.content?.[0]?.text || '{}');
  const order = mesh.models?.find(m => m.name === 'fct_order');
  if (mesh.provider === 'sqlmesh' && mesh.status === 'ready' && mesh.count === 7
      && order?.provenance?.types === 'sqlmesh-inferred'
      && order.qualifiedName.includes('"analytics"."fct_order"')
      && order.columns.some(c => c.name === 'customer_id')
      && mesh.relationships?.[0]?.cardinality === 'many-to-one') {
    console.log('✅ SQLMesh models, columns, identities, provenance and relationships');
  } else { fail('SQLMesh metadata differs from fixture'); console.log(mesh); }
  const nativeDomain = await rpc('tools/call', {
    name: 'read_domain', arguments: { project_path: SQLMESH_PATH, layer: 'silver', domain: 'orders' },
  });
  summarize('SQLMesh read_domain', nativeDomain);
  const boundResult = await rpc('tools/call', {
    name: 'list_project_models', arguments: { project_path: BOUND_PATH },
  });
  const boundData = JSON.parse(boundResult.result?.content?.[0]?.text || '{}');
  const boundOrder = boundData.models?.find(m => m.name === 'fct_order');
  if (boundOrder?.columns.some(c => c.name === 'customer_key' && c.nativeName === 'customer_id')
      && boundData.relationships?.[0]?.fromColumn === 'customer_key') {
    console.log('✅ SQLMesh explicit column aliases retain native identifiers and relationship endpoints');
  } else { fail('SQLMesh bound identity was lost in MCP output'); }
  if (boundData.pendingModels?.[0]?.name === 'new_model' && !boundData.models?.some(m => m.name === 'new_model')) {
    console.log('✅ SQLMesh pending bindings remain separate from loaded models');
  } else { fail('SQLMesh pending binding was lost or presented as a loaded model'); }

  // 8. Call get_editor_setup
  console.log('\n--- get_editor_setup ---');
  const ges = await rpc('tools/call', {
    name: 'get_editor_setup',
    arguments: {},
  });
  if (ges.result?.content?.[0]?.text?.includes('marketplace.visualstudio.com')) {
    console.log('✅ get_editor_setup returns marketplace link');
  } else {
    fail('get_editor_setup missing marketplace link');
    console.log(ges);
  }

  // 9. Verify graceful "not initialized" tip on uninitialized project
  console.log('\n--- list_domains on UNINITIALIZED project ---');
  const uninit = await rpc('tools/call', {
    name: 'list_domains',
    arguments: { project_path: UNINIT_PATH },
  });
  const uninitText = uninit.result?.content?.[0]?.text || '';
  if (uninitText.includes('tip') && uninitText.includes('marketplace.visualstudio.com')) {
    console.log('✅ uninitialized project returns tip pointing to extension');
  } else {
    fail('uninitialized fallback missing tip');
    console.log(uninitText.slice(0, 300));
  }

  // Cleanup
  fs.rmSync(UNINIT_PATH, { recursive: true, force: true });
  fs.rmSync(BOUND_PATH, { recursive: true, force: true });
  child.kill();
  if (failed) {
    console.error('\nSmoke test: one or more checks failed');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Smoke test failed:', e);
  fs.rmSync(BOUND_PATH, { recursive: true, force: true });
  child.kill();
  process.exit(1);
});
