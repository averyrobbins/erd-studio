import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SqlmeshRefreshCoordinator } from '../../src/services/sqlmeshAutoRefresh';
import { isSqlmeshSourceInput, sqlmeshWatchPatterns } from '../../src/services/sqlmeshAdapter';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

it('requires opt-in and coalesces a save burst into one export', async () => {
  let enabled = false;
  const refresh = vi.fn().mockResolvedValue(undefined);
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => enabled, refresh, onError: vi.fn() });
  queue.changed(); await vi.advanceTimersByTimeAsync(2000);
  expect(refresh).not.toHaveBeenCalled();
  enabled = true;
  queue.changed(); await vi.advanceTimersByTimeAsync(500); queue.changed();
  await vi.advanceTimersByTimeAsync(999); expect(refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(refresh).toHaveBeenCalledTimes(1);
  queue.dispose();
});

it('serializes changes during a running export and retries once with the latest inputs', async () => {
  const first = deferred();
  const refresh = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => true, refresh, onError: vi.fn() });
  queue.changed(); await vi.advanceTimersByTimeAsync(1000);
  queue.changed(); queue.changed(); await vi.advanceTimersByTimeAsync(2000);
  expect(refresh).toHaveBeenCalledTimes(1);
  await expect(queue.run(async () => undefined)).rejects.toThrow('already running');
  first.resolve(); await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
  queue.dispose();
});

it('an explicit refresh supersedes a pending automatic refresh', async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => true, refresh, onError: vi.fn() });
  queue.changed();
  await queue.run(async () => 'manual');
  await vi.advanceTimersByTimeAsync(2000);
  expect(refresh).not.toHaveBeenCalled();
  queue.dispose();
});

it('disabling automatic refresh aborts it and suppresses cancellation errors', async () => {
  let enabled = true, signal: AbortSignal | undefined;
  const onError = vi.fn();
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => enabled, onError,
    refresh: s => { signal = s; return new Promise((_, reject) => s.addEventListener('abort', () => reject(new Error('cancelled')))); } });
  queue.changed(); await vi.advanceTimersByTimeAsync(1000);
  enabled = false; queue.disableAutomatic();
  await vi.advanceTimersByTimeAsync(2000);
  expect(signal?.aborted).toBe(true); expect(onError).not.toHaveBeenCalled();
  queue.dispose();
});

it('reports a failed refresh and permits recovery on the next save', async () => {
  const refresh = vi.fn().mockRejectedValueOnce(new Error('invalid SQL')).mockResolvedValue(undefined);
  const onError = vi.fn();
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => true, refresh, onError });
  queue.changed(); await vi.advanceTimersByTimeAsync(1000);
  expect(onError).toHaveBeenCalledTimes(1);
  queue.changed(); await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(2);
  queue.dispose();
});

it('disposal cancels an explicit operation and queued work', async () => {
  const queue = new SqlmeshRefreshCoordinator({ enabled: () => true, refresh: vi.fn(), onError: vi.fn() });
  let signal: AbortSignal | undefined;
  const pending = deferred();
  const run = queue.run(s => { signal = s; return pending.promise; });
  queue.changed(); queue.dispose();
  expect(signal?.aborted).toBe(true);
  pending.resolve(); await run;
  await expect(queue.run(async () => {})).rejects.toThrow('closed');
});

it('watches standard inputs without treating metadata or logical edits as source execution triggers', () => {
  for (const f of ['models/a.sql', 'macros/sub/a.py', 'audits/a.sql', 'seeds/a.csv', 'external_models/a.yaml', 'config.yml', 'docs/erd/sqlmesh-bindings.json']) {
    expect(isSqlmeshSourceInput(f, 'docs/erd')).toBe(true);
  }
  for (const f of ['docs/erd/sqlmesh.json', 'docs/erd/.sync-plan.json', 'docs/erd/logical-models/a.yml', 'models/.cache/a.py', 'node_modules/a.sql', 'models/a.pyc']) {
    expect(isSqlmeshSourceInput(f, 'docs/erd')).toBe(false);
  }
  expect(sqlmeshWatchPatterns('docs/erd')).toContain('docs/erd/sqlmesh*.json');
  expect(sqlmeshWatchPatterns('docs/erd').every(p => !p.includes('{'))).toBe(true);
});
