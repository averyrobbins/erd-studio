import { describe, expect, it } from 'vitest';
import { findByIdentifier, foldIdentifier, logicalSpelling, matchIdentifiers, sameIdentifier } from '../../src/services/identifierMatching';

const cols = (...names: string[]) => names.map((name) => ({ name }));

describe('foldIdentifier / sameIdentifier / logicalSpelling', () => {
  it('folds by strategy and trims', () => {
    expect(foldIdentifier(' Customer_Id ', 'lower')).toBe('customer_id');
    expect(foldIdentifier('Customer_Id', 'upper')).toBe('CUSTOMER_ID');
    expect(foldIdentifier(' Customer_Id ', 'exact')).toBe('Customer_Id');
  });

  it('treats a logical lowercase name as the engine-folded physical one', () => {
    expect(sameIdentifier('customer_id', 'CUSTOMER_ID', 'upper')).toBe(true);
    expect(sameIdentifier('customer_id', 'CUSTOMER_ID', 'lower')).toBe(true);
    expect(sameIdentifier('customer_id', 'CUSTOMER_ID', 'exact')).toBe(false);
    expect(sameIdentifier('CUSTOMER_ID', 'CUSTOMER_ID', 'exact')).toBe(true);
  });

  it('writes lowercase into the design wherever the engine folds case', () => {
    expect(logicalSpelling('CUSTOMER_ID', 'upper')).toBe('customer_id');
    expect(logicalSpelling('Customer_Id', 'lower')).toBe('customer_id');
    expect(logicalSpelling('Customer_Id', 'exact')).toBe('Customer_Id');
  });
});

describe('findByIdentifier', () => {
  it('prefers an exact match and otherwise accepts a single folded one', () => {
    const items = cols('ID', 'id', 'CUSTOMER_ID');
    expect(findByIdentifier(items, 'id', 'upper')?.name).toBe('id');
    expect(findByIdentifier(items, 'ID', 'upper')?.name).toBe('ID');
    expect(findByIdentifier(items, 'customer_id', 'upper')?.name).toBe('CUSTOMER_ID');
    expect(findByIdentifier(items, 'customer_id', 'exact')).toBeUndefined();
  });

  it('refuses to guess between two folded candidates', () => {
    expect(findByIdentifier(cols('Amount', 'AMOUNT'), 'amount', 'upper')).toBeUndefined();
  });
});

describe('matchIdentifiers', () => {
  it('pairs a lowercase logical design with an upper-folding engine', () => {
    const source = cols('order_id', 'customer_id', 'amount');
    const target = cols('ORDER_ID', 'CUSTOMER_ID', 'CREATED_AT');
    const { pairs, unmatchedTarget } = matchIdentifiers(source, target, 'upper');
    expect([...pairs.entries()].map(([s, t]) => [s.name, t.name])).toEqual([['order_id', 'ORDER_ID'], ['customer_id', 'CUSTOMER_ID']]);
    expect(unmatchedTarget.map((t) => t.name)).toEqual(['CREATED_AT']);
  });

  it('keeps a quoted "id" and an unquoted ID apart when both exist', () => {
    const source = cols('id', 'ID');
    const target = cols('ID', 'id');
    const { pairs, unmatchedTarget } = matchIdentifiers(source, target, 'upper');
    expect(pairs.get(source[0])?.name).toBe('id');
    expect(pairs.get(source[1])?.name).toBe('ID');
    expect(unmatchedTarget).toEqual([]);
  });

  it('leaves an ambiguous folded key unmatched on both sides', () => {
    const source = cols('amount');
    const target = cols('Amount', 'AMOUNT');
    const { pairs, unmatchedTarget } = matchIdentifiers(source, target, 'upper');
    expect(pairs.size).toBe(0);
    expect(unmatchedTarget.map((t) => t.name)).toEqual(['Amount', 'AMOUNT']);
  });

  it('never folds under exact', () => {
    const source = cols('customer_id');
    const target = cols('CUSTOMER_ID');
    const { pairs, unmatchedTarget } = matchIdentifiers(source, target, 'exact');
    expect(pairs.size).toBe(0);
    expect(unmatchedTarget.map((t) => t.name)).toEqual(['CUSTOMER_ID']);
  });

  it('claims each target at most once even with duplicate exact names', () => {
    const source = cols('a', 'a');
    const target = cols('a');
    const { pairs } = matchIdentifiers(source, target, 'lower');
    expect(pairs.size).toBe(1);
  });

  it('is what the dbt comparison always did for ordinary names (lowercase fold)', () => {
    const source = cols('Customer_Id', 'order_id');
    const target = cols('CUSTOMER_ID', 'ORDER_ID');
    const { pairs, unmatchedTarget } = matchIdentifiers(source, target, 'lower');
    expect(pairs.size).toBe(2);
    expect(unmatchedTarget).toEqual([]);
  });
});
