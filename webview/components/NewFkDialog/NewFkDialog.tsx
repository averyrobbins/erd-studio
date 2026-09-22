/** One relationship, with one or more ordered column pairs. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';
import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import { detectCircularFk, formatCyclePath } from '../../lib/validation';
import type { Cardinality } from '../../../src/types/semantic';
import { relationshipPairs, relationshipColumns, relationshipColumnLabel, sameRelationship,
  validRelationshipColumns, type ColumnPair } from '../../../src/types/relationships';
import './NewFkDialog.css';

const emptyPair = (): ColumnPair => ({ fromColumn: '', toColumn: '' });

export function NewFkDialog() {
  const isOpen = useEditorStore(s => s.newFkDialogOpen);
  const setOpen = useEditorStore(s => s.setNewFkDialogOpen);
  const domain = useEditorStore(s => s.domain);
  const prefill = useEditorStore(s => s.fkDialogPrefill);
  const clearPrefill = useEditorStore(s => s.clearFkDialogPrefill);
  const original = useEditorStore(s => s.fkDialogEditData);
  const clearOriginal = useEditorStore(s => s.clearFkDialogEditData);
  const send = useSend();
  const [fromModel, setFromModel] = useState('');
  const [toModel, setToModel] = useState('');
  const [pairs, setPairs] = useState<ColumnPair[]>([emptyPair()]);
  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const sourceColumns = domain?.models.find(m => m.name === fromModel)?.columns.map(c => c.name) ?? [];
  const targetColumns = domain?.models.find(m => m.name === toModel)?.columns.map(c => c.name) ?? [];
  const candidate = { fromModel, toModel, ...relationshipColumns(pairs.map(p => ({
    fromColumn: p.fromColumn.trim(), toColumn: p.toColumn.trim(),
  }))) };
  const complete = !!fromModel && !!toModel && pairs.every(p => p.fromColumn.trim() && p.toColumn.trim());
  const duplicate = complete && domain?.relationships.some(r => (!original || !sameRelationship(r, original)) && sameRelationship(r, candidate));
  const invalidPairs = complete && !validRelationshipColumns(candidate);
  const missingColumn = complete && pairs.some(p => (sourceColumns.length > 0 && !sourceColumns.includes(p.fromColumn))
    || (targetColumns.length > 0 && !targetColumns.includes(p.toColumn)));
  const selfReference = !!fromModel && fromModel === toModel;
  const valid = complete && !duplicate && !invalidPairs && !missingColumn && !selfReference;
  const circularWarning = useMemo(() => {
    if (!fromModel || !toModel || fromModel === toModel) return null;
    const relationships = (domain?.relationships ?? []).filter(r => !original || !sameRelationship(r, original));
    const cycle = detectCircularFk(relationships, fromModel, toModel);
    return cycle ? `This will create a circular reference: ${formatCyclePath(cycle)}` : null;
  }, [domain, original, fromModel, toModel]);

  useEffect(() => {
    if (!isOpen) return;
    setFromModel(original?.fromModel ?? prefill?.fromModel ?? '');
    setToModel(original?.toModel ?? prefill?.toModel ?? '');
    setPairs(original ? relationshipPairs(original).map(p => ({ ...p }))
      : [{ fromColumn: prefill?.fromColumn ?? '', toColumn: prefill?.toColumn ?? '' }]);
    setCardinality(original?.cardinality ?? 'many-to-one');
  }, [isOpen, original, prefill]);

  const close = useCallback(() => { setOpen(false); clearPrefill(); clearOriginal(); }, [setOpen, clearPrefill, clearOriginal]);
  const submit = () => {
    if (!valid) return;
    if (original) {
      send({ type: 'editRelationship', payload: {
        originalFromModel: original.fromModel, originalToModel: original.toModel,
        originalFromColumn: original.fromColumn, originalToColumn: original.toColumn,
        ...(original.columnPairs ? { originalColumnPairs: original.columnPairs } : {}),
        ...candidate, cardinality,
      } });
    } else send({ type: 'addRelationship', payload: { ...candidate, cardinality } });
    close();
  };
  const updatePair = (index: number, side: keyof ColumnPair, value: string) =>
    setPairs(current => current.map((p, i) => i === index ? { ...p, [side]: value } : p));
  const movePair = (index: number, delta: number) => setPairs(current => {
    const next = [...current];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    return next;
  });
  if (!isOpen) return null;

  return <Panel position="top-center" className="new-fk-dialog">
    <div className="new-fk-dialog__header">
      <h3 className="new-fk-dialog__title">{original ? 'Edit Relationship' : 'New Relationship'}</h3>
      <button className="new-fk-dialog__close" onClick={close} title="Close dialog" aria-label="Close dialog">×</button>
    </div>
    <div className="new-fk-dialog__content">
      {(['from', 'to'] as const).map(side => <div className="new-fk-dialog__field" key={side}>
        <label className="new-fk-dialog__label" htmlFor={`${side}Model`}>{side === 'from' ? 'Source' : 'Target'} Model</label>
        <select id={`${side}Model`} className="new-fk-dialog__select" value={side === 'from' ? fromModel : toModel}
          onChange={e => {
            (side === 'from' ? setFromModel : setToModel)(e.target.value);
            setPairs(current => current.map(p => ({ ...p, [side === 'from' ? 'fromColumn' : 'toColumn']: '' })));
          }}>
          <option value="">Select model...</option>
          {(domain?.models ?? []).map(m => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
      </div>)}
      <div className="new-fk-dialog__label">Ordered column pairs</div>
      {pairs.map((pair, index) => <div className="new-fk-dialog__pair" key={index}>
        {(['from', 'to'] as const).map(side => {
          const field = side === 'from' ? 'fromColumn' : 'toColumn';
          const columns = side === 'from' ? sourceColumns : targetColumns;
          const id = index === 0 ? field : `${field}-${index}`;
          return <div className="new-fk-dialog__field" key={side}>
            <label className="new-fk-dialog__label" htmlFor={id}>{index + 1}. {side === 'from' ? 'Source (FK)' : 'Target'}</label>
            {columns.length ? <select id={id} className="new-fk-dialog__select" value={pair[field]}
              onChange={e => updatePair(index, field, e.target.value)}>
              <option value="">Select column...</option>
              {columns.map(c => <option key={c} value={c}>{c}</option>)}
            </select> : <input id={id} className="new-fk-dialog__input" value={pair[field]}
              disabled={!(side === 'from' ? fromModel : toModel)} placeholder="Enter column name..."
              onChange={e => updatePair(index, field, e.target.value)} />}
          </div>;
        })}
        {pairs.length > 1 && <div className="new-fk-dialog__pair-actions">
          <button aria-label={`Move pair ${index + 1} up`} disabled={index === 0} onClick={() => movePair(index, -1)}>↑</button>
          <button aria-label={`Move pair ${index + 1} down`} disabled={index === pairs.length - 1} onClick={() => movePair(index, 1)}>↓</button>
          <button aria-label={`Remove pair ${index + 1}`} onClick={() => setPairs(current => current.filter((_, i) => i !== index))}>Remove</button>
        </div>}
      </div>)}
      <button className="new-fk-dialog__button new-fk-dialog__button--secondary" onClick={() => setPairs(current => [...current, emptyPair()])}>Add column pair</button>
      <div className="new-fk-dialog__field">
        <label className="new-fk-dialog__label" htmlFor="cardinality">Cardinality</label>
        <select id="cardinality" className="new-fk-dialog__select" value={cardinality} onChange={e => setCardinality(e.target.value as Cardinality)}>
          <option value="many-to-one">Many-to-One (*→1)</option>
          <option value="one-to-one">One-to-One (1→1)</option>
          <option value="one-to-many">One-to-Many (1→*)</option>
          <option value="many-to-many">Many-to-Many (*→*)</option>
        </select>
      </div>
      {selfReference && <div className="new-fk-dialog__error">A model cannot have a relationship with itself</div>}
      {duplicate && <div className="new-fk-dialog__error">This relationship already exists</div>}
      {invalidPairs && <div className="new-fk-dialog__error">Use each source and target column only once in this relationship.</div>}
      {missingColumn && <div className="new-fk-dialog__error">Select columns present in both models.</div>}
      {circularWarning && <div className="new-fk-dialog__warning">{circularWarning}</div>}
      {complete && <div className="new-fk-dialog__preview">
        {fromModel}.{relationshipColumnLabel(candidate, 'from')} → {toModel}.{relationshipColumnLabel(candidate, 'to')}
      </div>}
    </div>
    <div className="new-fk-dialog__footer">
      <button className="new-fk-dialog__button new-fk-dialog__button--secondary" onClick={close}>Cancel</button>
      <button className="new-fk-dialog__button new-fk-dialog__button--primary" disabled={!valid} onClick={submit}>{original ? 'Save Changes' : 'Create Relationship'}</button>
    </div>
  </Panel>;
}
