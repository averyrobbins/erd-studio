// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NewFkDialog } from '../../webview/components/NewFkDialog/NewFkDialog';
import { useEditorStore } from '../../webview/store/editorStore';
import type { DisplayDomain } from '../../src/types/display';
const send = vi.hoisted(() => vi.fn());
vi.mock('../../webview/hooks/useMessageBus', () => ({ useSend: () => send }));
vi.mock('@xyflow/react', () => ({ Panel: ({ children }: any) => <div>{children}</div> }));
const initial = useEditorStore.getState();
const pairs = [{ fromColumn: 'a', toColumn: 'x' }, { fromColumn: 'b', toColumn: 'y' }];
const single = { fromModel: 'child', fromColumn: 'a', toModel: 'parent', toColumn: 'x', cardinality: 'many-to-one' as const };
const tuple = { ...single, columnPairs: pairs };
beforeEach(() => {
  send.mockClear();
  useEditorStore.setState({ ...initial, newFkDialogOpen: true, domain: {
    domain: 'tuple', layer: 'silver', stage: 'logical', viewConfig: {}, relationships: [single],
    models: [{ name: 'child', columns: ['a','b'].map(name => ({ name })) }, { name: 'parent', columns: ['x','y'].map(name => ({ name })) }],
  } as DisplayDomain });
});
afterEach(() => { cleanup(); useEditorStore.setState(initial); });
it('creates an ordered tuple sharing a single edge anchor and permits reordering', () => {
  render(<NewFkDialog />);
  fireEvent.change(screen.getByLabelText('Source Model'), { target: { value: 'child' } });
  fireEvent.change(screen.getByLabelText('Target Model'), { target: { value: 'parent' } });
  fireEvent.change(screen.getByLabelText('1. Source (FK)'), { target: { value: 'a' } });
  fireEvent.change(screen.getByLabelText('1. Target'), { target: { value: 'x' } });
  expect((screen.getByText('Create Relationship') as HTMLButtonElement).disabled).toBe(true); // existing single
  fireEvent.click(screen.getByText('Add column pair'));
  fireEvent.change(screen.getByLabelText('2. Source (FK)'), { target: { value: 'b' } });
  fireEvent.change(screen.getByLabelText('2. Target'), { target: { value: 'y' } });
  fireEvent.click(screen.getByLabelText('Move pair 2 up'));
  fireEvent.click(screen.getByText('Create Relationship'));
  expect(send).toHaveBeenCalledWith({ type: 'addRelationship', payload: { ...single, fromColumn: 'b', toColumn: 'y', columnPairs: [pairs[1], pairs[0]] } });
});
it('preserves the original tuple identity while editing and excludes duplicate components', () => {
  useEditorStore.setState({ fkDialogEditData: tuple, domain: { ...useEditorStore.getState().domain!, relationships: [single,tuple] } });
  render(<NewFkDialog />);
  fireEvent.change(screen.getByLabelText('2. Source (FK)'), { target: { value: 'a' } });
  expect((screen.getByText('Save Changes') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('2. Source (FK)'), { target: { value: 'b' } });
  fireEvent.change(screen.getByLabelText('Cardinality'), { target: { value: 'one-to-one' } });
  fireEvent.click(screen.getByText('Save Changes'));
  expect(send.mock.calls[0][0]).toMatchObject({ type: 'editRelationship', payload: {
    originalColumnPairs: pairs, columnPairs: pairs, cardinality: 'one-to-one',
  } });
});
it('can reduce a tuple to a single edge after removing its first pair', () => {
  useEditorStore.setState({ fkDialogEditData: tuple });
  render(<NewFkDialog />);
  fireEvent.click(screen.getByLabelText('Remove pair 1'));
  fireEvent.click(screen.getByText('Save Changes'));
  expect(send.mock.calls[0][0].payload).toMatchObject({ fromColumn: 'b', toColumn: 'y', originalColumnPairs: pairs });
  expect(send.mock.calls[0][0].payload.columnPairs).toBeUndefined();
});
