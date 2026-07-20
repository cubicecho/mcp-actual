import * as api from '@actual-app/api';
import { errorChainMessage } from '../errors.ts';
import type { ActualClient } from './client.ts';
import { money } from './money.ts';
import type { Schedule, Tag } from './types.ts';

/** The entity kinds `getIDByName` can resolve. */
export type ResolvableType = 'accounts' | 'categories' | 'payees' | 'schedules';

export interface ContextRepo {
  resolveNameToId(type: ResolvableType, name: string): Promise<string | null>;
  listSchedules(): Promise<Schedule[]>;
  listTags(): Promise<Tag[]>;
  getNote(id: string): Promise<string | null>;
  updateNote(id: string, note: string): Promise<string | null>;
  sync(): Promise<void>;
  runBankSync(accountId?: string): Promise<{ syncedAccounts: string[] }>;
  serverVersion(): Promise<string | null>;
}

/**
 * A schedule as `api/schedules-get` returns it. It maps through
 * `scheduleModel.toExternal`, which renames the internal `_payee`/`_account`/
 * `_amount`/`_date` fields to their unprefixed forms — reading the underscored
 * names off the result yields undefined for every one of them.
 */
export type RawSchedule = Awaited<ReturnType<typeof api.getSchedules>>[number] & {
  name?: unknown;
  account?: unknown;
  payee?: unknown;
  amount?: unknown;
  amountOp?: unknown;
  date?: unknown;
  next_date?: unknown;
  completed?: unknown;
  posts_transaction?: unknown;
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function toSchedule(raw: RawSchedule): Schedule {
  // `amount` is a number for most operators but `{ num1, num2 }` when
  // `amountOp` is "isbetween", so the range is reported rather than dropped.
  const amount = raw.amount;
  const range =
    typeof amount === 'object' && amount !== null ? (amount as { num1?: unknown; num2?: unknown }) : undefined;
  return {
    id: raw.id,
    name: str(raw.name),
    accountId: str(raw.account),
    payeeId: str(raw.payee),
    ...(typeof amount === 'number' ? money(amount) : {}),
    amountOp: str(raw.amountOp),
    amountMin: typeof range?.num1 === 'number' ? range.num1 : undefined,
    amountMax: typeof range?.num2 === 'number' ? range.num2 : undefined,
    nextDate: str(raw.next_date),
    completed: Boolean(raw.completed),
    posts_transaction: Boolean(raw.posts_transaction),
  };
}

export function createContextRepo(client: ActualClient): ContextRepo {
  return {
    /**
     * Name → id for the four entity kinds Actual can resolve. Returns null
     * rather than throwing when there is no match: "no such payee" is an
     * ordinary answer for an agent probing before it creates one.
     */
    resolveNameToId: (type, name) =>
      client.read(async () => {
        try {
          const id = await api.getIDByName(type, name);
          return id ?? null;
        } catch (cause) {
          // Only "no such entity" may become a null answer. The handler throws
          // the same way for a closed budget or a query failure, and swallowing
          // those made "the budget is not open" look identical to "does not
          // exist" — on which an agent would go on to create a duplicate.
          const message = errorChainMessage(cause);
          if (/^Not found:/.test(message)) {
            return null;
          }
          throw new Error(`Failed to resolve ${type} named "${name}": ${message}`, { cause });
        }
      }),

    listSchedules: () =>
      client.read(async () => {
        const raw = (await api.getSchedules()) as RawSchedule[];
        return raw.map(toSchedule);
      }),

    listTags: () =>
      client.read(async () => {
        const raw = await api.getTags();
        return raw.map(
          (tag): Tag => ({
            id: tag.id,
            tag: tag.tag,
            color: tag.color ?? undefined,
            description: tag.description ?? undefined,
          }),
        );
      }),

    getNote: (id) =>
      client.read(async () => {
        const note = await api.getNote(id);
        return note?.note ?? null;
      }),

    updateNote: (id, note) =>
      client.run(async () => {
        await api.updateNote(id, note);
        const saved = await api.getNote(id);
        return saved?.note ?? null;
      }),

    sync: () => client.run(() => api.sync()),

    /**
     * Pull fresh transactions from linked banks. Slow and rate-limited
     * upstream, so it is a deliberate tool call rather than something the
     * read tools do implicitly.
     */
    /**
     * Pull transactions from linked banks. Actual's handler only raises when an
     * account it *attempted* failed: it selects open, non-tombstoned accounts
     * and then skips any without a bank link, so an unknown, closed, or
     * unlinked account syncs nothing and reports no error at all.
     *
     * `getAccounts` does not expose the link (its external shape is id, name,
     * offbudget, closed, balance_current), so eligibility is read through AQL,
     * where `account_id` is the field the handler itself requires. Refusing on
     * a missing `account_id` cannot produce a false refusal — the handler would
     * have skipped that account regardless.
     */
    runBankSync: (accountId) =>
      client.read(async () => {
        const { data } = (await api.aqlQuery(
          api.q('accounts').filter({ closed: false }).select(['id', 'name', 'account_id']),
        )) as { data: { id: string; name: string; account_id?: string | null }[] };
        const linked = data.filter((account) => account.account_id);
        if (accountId) {
          if (!linked.some((account) => account.id === accountId)) {
            throw new Error(
              `Account "${accountId}" cannot bank-sync: it is closed, does not exist, or is not linked to a bank. ` +
                `Linked accounts: ${linked.map((account) => account.name).join(', ') || '(none)'}`,
            );
          }
        } else if (linked.length === 0) {
          throw new Error('No open account is linked to a bank, so there is nothing to sync.');
        }
        await api.runBankSync(accountId ? { accountId } : undefined);
        const synced = accountId ? linked.filter((account) => account.id === accountId) : linked;
        return { syncedAccounts: synced.map((account) => account.name) };
      }),

    serverVersion: () =>
      client.run(async () => {
        const result = await api.getServerVersion();
        return 'version' in result ? result.version : null;
      }),
  };
}
