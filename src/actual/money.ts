import * as api from '@actual-app/api';
import type { Money } from './types.ts';

/**
 * Render an integer cent amount as a {@link Money} pair. Conversion happens
 * exactly once, at the boundary — everything upstream sums integers, because
 * float arithmetic on money silently loses cents.
 */
export function money(amount: number): Money {
  return { amount, amountDecimal: api.utils.integerToAmount(amount) };
}
