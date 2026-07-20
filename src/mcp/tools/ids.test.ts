import { describe, expect, it } from 'vitest';
import { idSchema, isSafeId } from './ids.ts';

describe('idSchema', () => {
  it('accepts the uuids Actual mints, and plain slugs', () => {
    expect(idSchema.safeParse('729cbcbb-5f6a-4e1f-9d1a-2b9f0e7a1c33').success).toBe(true);
    expect(idSchema.safeParse('to-budget').success).toBe(true);
  });

  it('rejects an id that would break out of an AQL IN list', () => {
    // AQL emits `id IN ('<value>')` with no escaping for id-typed fields, so a
    // quote turns a targeted lookup into one matching every row.
    expect(idSchema.safeParse("x') OR 1=1 --").success).toBe(false);
    expect(idSchema.safeParse("a'b").success).toBe(false);
  });

  it('rejects whitespace and empty ids', () => {
    expect(idSchema.safeParse('').success).toBe(false);
    expect(idSchema.safeParse('a b').success).toBe(false);
  });

  it('isSafeId agrees with the schema', () => {
    expect(isSafeId('abc-123')).toBe(true);
    expect(isSafeId("x') OR 1=1 --")).toBe(false);
  });
});
