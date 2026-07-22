import { z } from 'zod';

/**
 * Characters an Actual entity id may contain. Actual mints ids with `uuid.v4`,
 * but a handful of built-ins are plain slugs, so this is deliberately wider
 * than a UUID pattern while still admitting nothing that could alter a query.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * An entity id at the tool boundary.
 *
 * This is a **security** boundary, not a typo check. AQL interpolates
 * id-typed values straight into SQL — `$oneof` emits
 * `` ids.map((id) => `'${String(id)}'`).join(',') `` and `val()` escapes quotes
 * only for `string`-typed fields, never for `id`-typed ones. An id containing a
 * quote therefore breaks out of the `IN (...)` list: passing
 * `x') OR 1=1 --` as a transaction id turns a targeted lookup into one that
 * matches the whole table, which `apply_rule_actions` would then write to.
 * Constraining the character set closes that off before the value reaches AQL.
 */
export const idSchema = z
  .string()
  .min(1)
  .regex(ID_PATTERN, 'Not a valid Actual id: ids are letters, digits, hyphens, and underscores.');

/** True when `value` is safe to interpolate as an id. Mirrors {@link idSchema} for repo-layer checks. */
export function isSafeId(value: string): boolean {
  return ID_PATTERN.test(value);
}
