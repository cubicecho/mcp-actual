import * as api from '@actual-app/api';
import type { ActualClient } from './client.ts';
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
  runBankSync(accountId?: string): Promise<void>;
  serverVersion(): Promise<string | null>;
}

type RawSchedule = Awaited<ReturnType<typeof api.getSchedules>>[number] & {
  name?: unknown;
  _account?: unknown;
  _payee?: unknown;
  _amount?: unknown;
  _date?: unknown;
  next_date?: unknown;
  completed?: unknown;
  posts_transaction?: unknown;
};

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function toSchedule(raw: RawSchedule): Schedule {
  return {
    id: raw.id,
    name: str(raw.name),
    accountId: str(raw._account),
    payeeId: str(raw._payee),
    amount: typeof raw._amount === 'number' ? raw._amount : undefined,
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
      client.run(async () => {
        try {
          const id = await api.getIDByName(type, name);
          return id ?? null;
        } catch {
          return null;
        }
      }),

    listSchedules: () =>
      client.run(async () => {
        const raw = (await api.getSchedules()) as RawSchedule[];
        return raw.map(toSchedule);
      }),

    listTags: () =>
      client.run(async () => {
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
      client.run(async () => {
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
    runBankSync: (accountId) => client.run(async () => api.runBankSync(accountId ? { accountId } : undefined)),

    serverVersion: () =>
      client.run(async () => {
        const result = await api.getServerVersion();
        return 'version' in result ? result.version : null;
      }),
  };
}
