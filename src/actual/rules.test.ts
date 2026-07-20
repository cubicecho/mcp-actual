import { describe, expect, it } from 'vitest';
import { diffTransaction } from './rules.ts';

/** Resolve the two id-bearing fields the way the repo does, so tests read like the real output. */
const NAMES = {
  payees: new Map([
    ['p-1', 'AMZN Mktp US*2H4'],
    ['p-2', 'Amazon'],
  ]),
  categories: new Map([['c-1', 'Shopping']]),
};
const resolve = (kind: 'payees' | 'categories', id: unknown): unknown =>
  typeof id === 'string' ? (NAMES[kind].get(id) ?? id) : id;

const BEFORE = {
  id: 't-1',
  date: '2026-07-01',
  amount: -2500,
  notes: null,
  cleared: true,
  payee: 'p-1',
  category: null,
};

describe('diffTransaction', () => {
  it('reports nothing when the rules changed nothing', () => {
    expect(diffTransaction(BEFORE, { ...BEFORE }, resolve)).toEqual({});
  });

  it('resolves payee and category ids to names, keeping the ids alongside', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, payee: 'p-2', category: 'c-1' }, resolve);
    expect(changes).toEqual({
      payee: { from: 'AMZN Mktp US*2H4', to: 'Amazon', fromId: 'p-1', toId: 'p-2' },
      category: { from: null, to: 'Shopping', fromId: null, toId: 'c-1' },
    });
  });

  it('carries toId so a preview can be turned into an apply without a name lookup', () => {
    // apply_rule_actions takes ids as action values; a name-only diff would
    // force an ambiguous resolve_name_to_id round-trip.
    const changes = diffTransaction(BEFORE, { ...BEFORE, category: 'c-1' }, resolve);
    expect(changes.category?.toId).toBe('c-1');
  });

  it('leaves an unresolvable id as the raw id rather than dropping it', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, category: 'c-unknown' }, resolve);
    expect(changes.category).toEqual({ from: null, to: 'c-unknown', fromId: null, toId: 'c-unknown' });
  });

  it('reports plain fields without name resolution', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, notes: 'groceries', cleared: false }, resolve);
    expect(changes).toEqual({
      notes: { from: null, to: 'groceries' },
      cleared: { from: true, to: false },
    });
  });

  it('treats undefined and null as the same absent value, so an omitted field is not a change', () => {
    // `rules-run` returns the transaction it was given; a field the engine never
    // touched can come back undefined where the row had null.
    const changes = diffTransaction(BEFORE, { ...BEFORE, notes: undefined, category: undefined }, resolve);
    expect(changes).toEqual({});
  });

  it('ignores fields outside the diffed set', () => {
    const changes = diffTransaction(BEFORE, { ...BEFORE, reconciled: true, account: 'a-9' }, resolve);
    expect(changes).toEqual({});
  });
});
