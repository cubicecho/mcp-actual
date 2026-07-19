import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
import type { Payee, PayeeDuplicateGroup } from './types.ts';

export interface PayeesRepo {
  list(options?: { withUsage?: boolean }): Promise<Payee[]>;
  findDuplicates(options?: { minGroupSize?: number }): Promise<PayeeDuplicateGroup[]>;
  merge(targetId: string, mergeIds: string[]): Promise<Payee | null>;
  update(id: string, fields: PayeeUpdate): Promise<Payee | null>;
  create(name: string): Promise<Payee | null>;
}

/**
 * Renaming is the only edit the public API supports: `APIPayeeEntity` is
 * `Pick<PayeeEntity, 'id' | 'name' | 'transfer_acct'>`, so `favorite` and
 * `learn_categories` are not reachable through `updatePayee` even though they
 * exist on the internal entity.
 */
export interface PayeeUpdate {
  name: string;
}

type RawPayee = Awaited<ReturnType<typeof api.getPayees>>[number];

function toPayee(raw: RawPayee): Payee {
  return {
    id: raw.id,
    name: raw.name,
    transferAccountId: raw.transfer_acct ?? undefined,
  };
}

/**
 * Reduce a payee name to a comparison key: lowercase, strip anything that is
 * not a letter or digit, and drop the trailing store/reference numbers card
 * networks append. `AMZN Mktp US*2H4G1` and `Amazon Mktp US` both collapse
 * toward `amznmktpus` / `amazonmktpus` — close enough to surface as candidates
 * for a human to judge, which is all this is for.
 */
export function normalizePayeeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#*]\s*\w+$/, '')
    .replace(/\b\d{3,}\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Group payees whose normalized names collide. Deliberately conservative: it
 * suggests, never merges, and reports why each group was formed so the agent
 * (and the user) can judge. Merging is destructive and irreversible, so a
 * false positive here must never be actionable without review.
 */
export function groupDuplicates(payees: Payee[], minGroupSize: number): PayeeDuplicateGroup[] {
  const byKey = new Map<string, Payee[]>();
  for (const payee of payees) {
    // Transfer payees mirror an account; merging them would corrupt transfers.
    if (payee.transferAccountId) {
      continue;
    }
    const key = normalizePayeeName(payee.name);
    if (!key) {
      continue;
    }
    const bucket = byKey.get(key);
    if (bucket) {
      bucket.push(payee);
    } else {
      byKey.set(key, [payee]);
    }
  }

  const groups: PayeeDuplicateGroup[] = [];
  for (const [key, members] of byKey) {
    if (members.length < minGroupSize) {
      continue;
    }
    // Most-used first: the busiest payee is the sane merge target, since
    // merging moves the others' transactions onto it.
    const ordered = [...members].sort((a, b) => (b.transactionCount ?? 0) - (a.transactionCount ?? 0));
    const [target, ...rest] = ordered;
    if (!target) {
      continue;
    }
    groups.push({
      suggestedTarget: target,
      candidates: rest,
      reason: `Names normalize to the same key ("${key}")`,
    });
  }
  // Biggest clusters first — they are where cleanup pays off most.
  return groups.sort((a, b) => b.candidates.length - a.candidates.length);
}

/** One `{payee, date}` row per transaction, newest first. */
interface UsageRow {
  payee: string | null;
  date: string | null;
}

/**
 * Fold newest-first `{payee, date}` rows into per-payee counts and last-used
 * dates. Pure, so the aggregation is testable without an Actual server.
 */
export function tallyUsage(rows: UsageRow[]): Map<string, { count: number; lastDate?: string }> {
  const usage = new Map<string, { count: number; lastDate?: string }>();
  for (const row of rows) {
    if (!row.payee) {
      continue;
    }
    const entry = usage.get(row.payee);
    if (entry) {
      entry.count += 1;
    } else {
      // Rows arrive newest-first, so the first one seen carries the last-used date.
      usage.set(row.payee, { count: 1, lastDate: row.date ?? undefined });
    }
  }
  return usage;
}

export function createPayeesRepo(client: ActualClient): PayeesRepo {
  /**
   * Attach transaction counts and last-used dates; the raw API returns bare
   * names, which is not enough to decide what to merge.
   *
   * AQL has no `$max`, so rather than one grouped query plus a second pass for
   * recency, this pulls two narrow columns for every transaction (newest first)
   * and folds them in memory. For a personal budget that is a few thousand tiny
   * rows — cheaper than it looks, and it yields both numbers from one query.
   */
  const withUsage = async (payees: Payee[]): Promise<Payee[]> => {
    const { data } = (await api.aqlQuery(
      api
        .q('transactions')
        .filter({ payee: { $ne: null } })
        .select(['payee', 'date'])
        .orderBy([{ date: 'desc' }]),
    )) as { data: UsageRow[] };
    const usage = tallyUsage(data);
    return payees.map((payee) => {
      const entry = usage.get(payee.id);
      return {
        ...payee,
        transactionCount: entry?.count ?? 0,
        lastTransactionDate: entry?.lastDate,
      };
    });
  };

  const findById = async (id: string): Promise<Payee | null> => {
    const found = (await api.getPayees()).find((p) => p.id === id);
    return found ? toPayee(found) : null;
  };

  return {
    list: (options) =>
      client.run(async () => {
        const payees = (await api.getPayees()).map(toPayee);
        return options?.withUsage ? withUsage(payees) : payees;
      }),

    findDuplicates: (options) =>
      client.run(async () => {
        // Always resolve usage here: the counts decide the merge target.
        const payees = await withUsage((await api.getPayees()).map(toPayee));
        return groupDuplicates(payees, options?.minGroupSize ?? 2);
      }),

    /**
     * Merge `mergeIds` into `targetId`. Actual moves the transactions and
     * tombstones the merged payees; there is no undo, which is why the tool
     * layer requires explicit ids rather than accepting names.
     */
    merge: (targetId, mergeIds) =>
      client.run(async () => {
        await api.mergePayees(targetId, mergeIds);
        return findById(targetId);
      }),

    update: (id, fields) =>
      client.run(async () => {
        await api.updatePayee(id, { name: fields.name });
        return findById(id);
      }),

    create: (name) =>
      client.run(async () => {
        const id = await api.createPayee({ name });
        return findById(id);
      }),
  };
}
