/**
 * The created-contacts resolution (#8313 W4b; spec 2026-10-19 §5.13), on the
 * compiled SQL and the real call arguments: the link is read first and wins;
 * the (org, lower(email)) lock is the inbound pipeline's own namespace and
 * key, taken before the email match; a miss creates a role-less contact with
 * destination source `import` and links it; a shared mailbox stays
 * display-only and creates nothing. The statements run against Postgres in
 * ticketImportContacts.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { getTableName } from 'drizzle-orm';

const dialect = new PgDialect();

const h = vi.hoisted(() => ({
  log: [] as Array<{ kind: string; sql?: string; params?: unknown[]; table?: string; values?: unknown }>,
  /** Rows per select, by table, consumed in order. */
  rows: new Map<string, unknown[][]>(),
  match: { kind: 'no-match' } as { kind: string; contactId?: string; reason?: string },
  createContact: vi.fn(async () => ({ id: 'c-new' })),
}));

vi.mock('../../db', () => {
  const select = () => {
    let table = '';
    const run = (lock?: string) => {
      h.log.push({ kind: 'select', table, ...(lock ? { sql: lock } : {}) });
      const queue = h.rows.get(table);
      return Promise.resolve(queue && queue.length > 0 ? queue.shift()! : []);
    };
    const builder: Record<string, unknown> = {
      from: (t: Parameters<typeof getTableName>[0]) => { table = getTableName(t); return builder; },
      where: () => builder,
      for: (mode: string) => ({ limit: () => run(mode) }),
      limit: () => Object.assign(run(), { for: (mode: string) => run(mode) }),
    };
    return builder;
  };
  return {
    db: {
      select,
      execute: (statement: unknown) => {
        const { sql, params } = dialect.sqlToQuery(statement as never);
        h.log.push({ kind: 'execute', sql, params });
        return Promise.resolve(undefined);
      },
      insert: (t: Parameters<typeof getTableName>[0]) => ({
        values: (values: unknown) => {
          h.log.push({ kind: 'insert', table: getTableName(t), values });
          return Promise.resolve(undefined);
        },
      }),
    },
    withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
  };
});

vi.mock('../contacts/crud', async (orig) => ({
  ...(await orig<typeof import('../contacts/crud')>()),
  matchContactByEmail: vi.fn(async () => { h.log.push({ kind: 'match' }); return h.match; }),
  createContact: h.createContact,
}));

import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import { importContactSystem, predictImportRequester, resolveImportRequester } from './importPeople';

const ORG = '11111111-1111-4111-8111-111111111111';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const request = { name: 'Maya Quinn', email: 'Maya@Customer.example', sourceUserKey: '812' };
const kinds = () => h.log.map((e) => (e.table ? `${e.kind}:${e.table}` : e.kind));

beforeEach(() => {
  h.log.length = 0;
  h.rows.clear();
  h.match = { kind: 'no-match' };
  h.createContact.mockClear();
});

describe('resolveImportRequester', () => {
  it('names the ledger ticket-import:<sourceId>', () => {
    expect(importContactSystem(SOURCE)).toBe(`ticket-import:${SOURCE}`);
  });

  it('this import\'s link wins: its contact, pinned FOR KEY SHARE, with no lock, match or write', async () => {
    h.rows.set('contact_external_links', [[{ contactId: 'c-linked' }]]);
    h.rows.set('contacts', [[{ id: 'c-linked' }]]);
    await expect(resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request })).resolves.toEqual({ kind: 'linked', contactId: 'c-linked' });
    expect(kinds()).toEqual(['select:contact_external_links', 'select:contacts']);
    expect(h.log[1]!.sql).toBe('key share');
  });

  it('a miss locks (org, lower(email)) in the inbound namespace before matching, then creates a role-less contact and its link', async () => {
    h.rows.set('contacts', [[{ updatedAt: new Date('2026-11-01T10:00:00.123Z') }]]);
    await expect(resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request })).resolves.toEqual({ kind: 'created', contactId: 'c-new' });
    expect(kinds()).toEqual(['select:contact_external_links', 'execute', 'match', 'select:contacts', 'insert:contact_external_links']);
    const lock = h.log[1]!;
    expect(lock.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
    expect(lock.params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG}:maya@customer.example`]);
    expect(h.createContact).toHaveBeenCalledWith(
      expect.anything(),
      { orgId: ORG, email: 'maya@customer.example', name: 'Maya Quinn', roles: [] },
      { userId: null, destinationSource: 'import' },
    );
    expect(h.log[4]!.values).toEqual({
      contactId: 'c-new', orgId: ORG, system: `ticket-import:${SOURCE}`, externalId: '812', createdBy: null,
      updatedAt: new Date('2026-11-01T10:00:00.123Z'),
    });
  });

  it('one email match is reused with no link; a shared mailbox or a vanished match stays display-only; neither creates', async () => {
    h.match = { kind: 'contact', contactId: 'c-one' };
    await expect(resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request })).resolves.toEqual({ kind: 'matched', contactId: 'c-one' });
    h.match = { kind: 'none', reason: 'shared-mailbox' };
    await expect(resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request })).resolves.toEqual({ kind: 'display_only', reason: 'shared_mailbox' });
    h.match = { kind: 'none', reason: 'vanished' };
    await expect(resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request })).resolves.toEqual({ kind: 'display_only', reason: 'vanished' });
    expect(h.createContact).not.toHaveBeenCalled();
    expect(h.log.some((e) => e.kind === 'insert')).toBe(false);
  });

  it('a name-less request creates a contact identified by its email alone', async () => {
    await resolveImportRequester({ orgId: ORG, sourceId: SOURCE, request: { email: 'x@customer.example', sourceUserKey: '9' } });
    expect(h.createContact).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ name: null, email: 'x@customer.example' }), expect.anything());
  });
});

describe('predictImportRequester (the dry run): the same order, read-only', () => {
  const ctx = { scope: 'partner' } as never;

  it('a link is linked; no contact is create; one is matched; two are display-only; nothing is locked or written', async () => {
    h.rows.set('contact_external_links', [[{ contactId: 'c-linked' }], [], [], []]);
    h.rows.set('contacts', [[], [{ id: 'a' }], [{ id: 'a' }, { id: 'b' }]]);
    const answers = [];
    for (let i = 0; i < 4; i += 1) answers.push(await predictImportRequester(ctx, { orgId: ORG, sourceId: SOURCE, request }));
    expect(answers).toEqual(['linked', 'create', 'matched', 'display_only']);
    expect(h.log.some((e) => e.kind === 'execute' || e.kind === 'insert' || e.kind === 'match')).toBe(false);
  });
});
