// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEditorStore } from '../../webview/store/editorStore';
import { DiscrepancyPanel } from '../../webview/components/DiscrepancyPanel/DiscrepancyPanel';
import { SyncMergeModal } from '../../webview/components/SyncMergeModal/SyncMergeModal';
import { PhysicalSourceNotice, formatWhen } from '../../webview/components/Canvas/PhysicalSourceNotice';
import { DetailPanel } from '../../webview/components/DetailPanel/DetailPanel';
import { compare } from '../../src/services/discrepancyService';
import type { DisplayDomain } from '../../src/types/display';

const post = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({ Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, useReactFlow: () => ({ fitView: vi.fn() }) }));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({ useVsCodeApi: () => ({ postMessage: post, getState: vi.fn(), setState: vi.fn() }) }));

beforeEach(() => {
  post.mockClear();
  const physical: DisplayDomain = { schemaVersion: 5, domain: 'orders', layer: 'silver', stage: 'physical',
    description: '', models: [{ name: 'orders', schema: '', description: '', columns: [{ name: 'id', dataType: 'INT', description: '', isPrimaryKey: false, isForeignKey: false }] }], relationships: [], viewConfig: {},
    integration: { provider: 'sqlmesh', status: 'ready', diagnostics: [] } };
  const logical = structuredClone(physical); logical.stage = 'logical'; logical.models[0].columns[0].dataType = 'TEXT';
  useEditorStore.setState({ domain: physical, discrepancyVisible: true, discrepancyReport: compare(physical, logical),
    syncMode: false, syncSelections: {}, syncPlanGenerated: null, manifestStale: false });
});
afterEach(cleanup);

it.each(['logical', 'physical'] as const)('offers source navigation from the %s details panel using model identity', stage => {
  const domain = structuredClone(useEditorStore.getState().domain!);
  domain.stage = stage; domain.models[0].sourcePath = 'models/orders.sql';
  useEditorStore.setState({ domain, selectedNode: 'orders', detailPanelOpen: true });
  render(<DetailPanel />);
  fireEvent.click(screen.getByRole('button', { name: 'Open model source' }));
  expect(post).toHaveBeenCalledWith({ type: 'openModelSource', payload: { modelName: 'orders' } });
});

it('enables native sync and selects the actual displayed stage when comparing from Physical', () => {
  render(<><DiscrepancyPanel /><SyncMergeModal /></>);
  fireEvent.click(screen.getByRole('button', { name: '⊕ Sync' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'All Physical' }));
  expect(useEditorStore.getState().syncSelections).toEqual({ 'col:orders:id': 'physical' });
  fireEvent.click(screen.getByRole('button', { name: /Prepare sync plan/ }));
  expect(post).toHaveBeenCalledWith({ type: 'generateSyncPlan', payload: { selections: { 'col:orders:id': 'physical' } } });
});

it('per-column acceptance respects reversed stage order and invalidates an old reviewed plan', () => {
  useEditorStore.setState({ syncMode: true, syncPlanGenerated: { filePath: 'plan', totalActions: 1, direction: 'logical-to-source' } });
  render(<SyncMergeModal />);
  fireEvent.click(screen.getByRole('button', { name: 'Physical' }));
  expect(useEditorStore.getState().syncSelections['col:orders:id']).toBe('physical');
  expect(useEditorStore.getState().syncPlanGenerated).toBeNull();
  expect(screen.getByRole('button', { name: /Prepare sync plan/ })).toBeTruthy();
});

it.each(['metadata-to-logical', 'logical-to-source'] as const)('exposes the correct execution route for %s', direction => {
  useEditorStore.setState({ syncMode: true, syncPlanGenerated: { filePath: 'plan', totalActions: 1, direction } });
  render(<SyncMergeModal />);
  fireEvent.click(screen.getByRole('button', { name: direction === 'metadata-to-logical' ? 'Apply to logical design' : 'Edit source with Claude' }));
  expect(post).toHaveBeenCalledWith({ type: direction === 'metadata-to-logical' ? 'applySqlmeshLogicalSync' : 'launchClaudeSync' });
});

it('labels environment observations, partial coverage and source-only columns', () => {
  const domain = structuredClone(useEditorStore.getState().domain!);
  domain.integration!.warehouse = { environment: 'dev', observedAt: '2026-09-20T10:00:00Z', observed: 1, total: 3 };
  useEditorStore.setState({ domain });
  render(<PhysicalSourceNotice />);
  expect(screen.getByRole('status').textContent).toContain('Warehouse dev: 1/3 models observed');
  expect(screen.getByRole('status').textContent).toContain('source-only columns are retained');
});

it('writes timestamps for the viewer, explains a stale export, and can be dismissed until a new export lands', () => {
  const domain = structuredClone(useEditorStore.getState().domain!);
  domain.integration = { provider: 'sqlmesh', status: 'stale', generatedAt: '2026-09-20T10:00:00Z', diagnostics: [] };
  useEditorStore.setState({ domain, physicalSourceNoticeDismissed: false });
  const { unmount } = render(<PhysicalSourceNotice />);
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toContain('SQLMesh export stale');
  expect(text).toContain('Refresh Project Metadata');
  expect(text).not.toContain('2026-09-20T10:00:00Z');
  expect(text).toContain(formatWhen('2026-09-20T10:00:00Z'));

  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByRole('status')).toBeNull();

  // The same payload again (a drag re-sets the domain) keeps it dismissed…
  useEditorStore.getState().setDomain(structuredClone(domain));
  unmount(); render(<PhysicalSourceNotice />);
  expect(screen.queryByRole('status')).toBeNull();

  // …a new export does not.
  const refreshed = structuredClone(domain);
  refreshed.integration = { provider: 'sqlmesh', status: 'ready', generatedAt: '2026-09-20T11:00:00Z', diagnostics: [] };
  useEditorStore.getState().setDomain(refreshed);
  cleanup(); render(<PhysicalSourceNotice />);
  expect(screen.getByRole('status').textContent).toContain('SQLMesh export current');
});

it('keeps the raw text when a timestamp does not parse', () => {
  expect(formatWhen('not a date')).toBe('not a date');
  expect(formatWhen('2026-09-20T10:00:00Z')).not.toBe('2026-09-20T10:00:00Z');
});

it('says why a whole inspection failed instead of reporting 0 of N observed', () => {
  const domain = structuredClone(useEditorStore.getState().domain!);
  domain.integration!.warehouse = { environment: 'prdo', observedAt: '2026-09-20T10:00:00Z', observed: 0, total: 3,
    diagnostic: "Environment 'prdo' was not found in SQLMesh state; check erdStudio.sqlmesh.environment or deploy that environment first" };
  useEditorStore.setState({ domain });
  render(<PhysicalSourceNotice />);
  const text = screen.getByRole('status').textContent ?? '';
  expect(text).toMatch(/inspection of prdo at .* failed/);
  expect(text).toContain("'prdo' was not found");
  expect(text).not.toContain('0/3 models observed');
});
