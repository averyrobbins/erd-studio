// @vitest-environment jsdom
import React from 'react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useEditorStore } from '../../webview/store/editorStore';
import { DiscrepancyPanel } from '../../webview/components/DiscrepancyPanel/DiscrepancyPanel';
import { SyncMergeModal } from '../../webview/components/SyncMergeModal/SyncMergeModal';
import { compare } from '../../src/services/discrepancyService';
import type { DisplayDomain } from '../../src/types/display';

vi.mock('@xyflow/react', () => ({
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useReactFlow: () => ({ fitView: vi.fn() }),
}));
vi.mock('../../webview/hooks/useVsCodeApi', () => ({
  useVsCodeApi: () => ({ postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() }),
}));

beforeEach(() => {
  const physical: DisplayDomain = { schemaVersion: 5, domain: 'orders', layer: 'silver', stage: 'physical',
    description: '', models: [], relationships: [], viewConfig: {},
    integration: { provider: 'sqlmesh', status: 'ready', diagnostics: [] } };
  const logical: DisplayDomain = { ...physical, stage: 'logical', models: [{ name: 'draft_model', schema: '', description: '', columns: [] }] };
  useEditorStore.setState({ domain: physical, discrepancyVisible: true, discrepancyReport: compare(physical, logical),
    syncMode: false, syncSelections: {}, manifestStale: false });
});
afterEach(cleanup);

it('displays native differences while disabling the unsupported sync entry point', () => {
  render(<DiscrepancyPanel />);
  expect(screen.getByText('draft_model')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Sync unavailable' }) as HTMLButtonElement).disabled).toBe(true);
});

it('ignores a restored dbt sync mode in a native project and keeps comparison visible', () => {
  useEditorStore.setState({ syncMode: true });
  render(<><DiscrepancyPanel /><SyncMergeModal /></>);
  expect(screen.getByText('draft_model')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});
