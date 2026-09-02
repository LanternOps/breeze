/**
 * #3258 W03 — inbound-email requester resolution onto `contacts`.
 *
 * These assertions are on the COMPILED SQL and the real call arguments, not on
 * "a builder was called": a WHERE built against a mocked table object compiles
 * to something that asserts nothing (memory: vacuous Drizzle where-clause
 * assertions). The behaviours that matter are all invisible to a
 * builder-shape assertion:
 *
 *  1. the advisory lock is taken FIRST, before the probe — the inbound worker
 *     runs at concurrency 5, so two first messages from one new sender would
 *     otherwise both see "no contact" and both create one — and it is the
 *     TWO-ARGUMENT namespaced form, so it cannot collide with the other
 *     hashtext locks this codebase takes on unrelated key spaces;
 *  2. a shared mailbox (several contacts on one address) resolves to
 *     `none`/'shared-mailbox' — never a guess by display name (spoofable) or
 *     by age, and never a fresh duplicate;
 *  3. the matched contact is pinned with FOR KEY SHARE before the caller
 *     writes a ticket FK against it, and a row that vanished under that lock
 *     degrades to `none`/'vanished' rather than handing back a dangling id;
 *  4. an unusable From address short-circuits BEFORE the lock — locking on an
 *     empty key would serialise every malformed message in the org against
 *     each other for the rest of the worker transaction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// A raw `sql` chunk has no .toSQL() of its own — compiling it needs a dialect.
const dialect = new PgDialect();
const compile = (statement: unknown) => dialect.sqlToQuery(statement as never);

const { executeMock, selectRowsMock, createContactMock } = vi.hoisted(() => ({
  executeMock: vi.fn().mockResolvedValue(undefined),
  selectRowsMock: vi.fn(),
  createContactMock: vi.fn(),
}));

// The ORDER of statements is the point of this suite, so every DB call lands
// in one ordered log rather than in per-builder recorders.
const calls: Array<{ kind: 'execute' | 'select'; sql: string; params: unknown[]; forShare?: string }> = [];

vi.mock('../../db', () => {
  const makeSelect = () => ({
    from: () => ({
      where: (w: unknown) => {
        const build = (forShare?: string) => {
          const { sql, params } = compile(w);
          calls.push({ kind: 'select', sql, params, forShare });
          return Promise.resolve(selectRowsMock());
        };
        return {
          limit: () =>
            Object.assign(build(), {
              for: (mode: string) => build(mode),
            }),
          for: (mode: string) => ({ limit: () => build(mode) }),
        };
      },
    }),
  });
  return {
    db: {
      select: () => makeSelect(),
      execute: (statement: unknown) => {
        const { sql, params } = compile(statement);
        calls.push({ kind: 'execute', sql, params });
        return executeMock();
      },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});

vi.mock('../contacts/crud', async () => {
  const actual = await vi.importActual<typeof import('../contacts/crud')>('../contacts/crud');
  return { ...actual, createContact: createContactMock };
});

import { INBOUND_CONTACT_LOCK_NAMESPACE, resolveEmailRequester } from './resolveOrg';

const ORG = '11111111-1111-4111-8111-111111111111';

describe('resolveEmailRequester', () => {
  beforeEach(() => {
    calls.length = 0;
    selectRowsMock.mockReset();
    createContactMock.mockReset();
    executeMock.mockClear();
  });

  it('takes the per-(org,email) advisory lock BEFORE probing for a contact', async () => {
    selectRowsMock.mockReturnValue([{ id: 'ct-1' }]);

    await resolveEmailRequester(ORG, 'Jane@Acme.Test', 'Jane');

    expect(calls[0]!.kind).toBe('execute');
    // The TWO-ARGUMENT namespaced form the rest of the repo uses
    // (discoveryJobCreation.ts, c2cJobCreation.ts, aiBudgetAlerts.ts): the
    // one-argument form shares a single 64-bit key space with every other
    // advisory lock in the process, so an unrelated feature hashing a
    // colliding string would block ingest.
    expect(calls[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
    // Keyed on the org AND the normalized address — a lock on the address
    // alone would serialise unrelated tenants.
    expect(calls[0]!.params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG}:jane@acme.test`]);
    expect(calls[1]!.kind).toBe('select');
  });

  it('creates a contact (and no portal_users row) when the sender is unknown', async () => {
    selectRowsMock.mockReturnValue([]);
    createContactMock.mockResolvedValue({ id: 'ct-new' });

    const result = await resolveEmailRequester(ORG, 'NEW@acme.test', 'New Person');

    expect(result).toEqual({ kind: 'contact', contactId: 'ct-new' });
    expect(createContactMock).toHaveBeenCalledTimes(1);
    const [, input, actor] = createContactMock.mock.calls[0]!;
    expect(input).toMatchObject({ orgId: ORG, email: 'new@acme.test', name: 'New Person', roles: [] });
    // A system-context create: there is no acting user on the inbound path.
    expect(actor).toEqual({ userId: null });
    // Every statement this path issues is against `contacts` (plus the
    // advisory lock). The old assertion here only said "no statement mentions
    // portal_users", which the mocked schema would satisfy even if the code
    // had gone back to minting logins through a differently-named builder.
    const tables = calls.filter((c) => c.kind === 'select').map((c) => c.sql);
    expect(tables.length).toBeGreaterThan(0);
    for (const statement of tables) expect(statement).toMatch(/"contacts"/);
  });

  it('probes on org_id AND lower(email), case-insensitively', async () => {
    selectRowsMock.mockReturnValue([{ id: 'ct-1' }]);

    await resolveEmailRequester(ORG, 'MiXeD@Acme.Test', null);

    const probe = calls.find((c) => c.kind === 'select')!;
    expect(probe.sql).toMatch(/"contacts"\."org_id" = \$\d/);
    expect(probe.sql).toMatch(/lower\("contacts"\."email"\) = \$\d/i);
    expect(probe.params).toEqual(expect.arrayContaining([ORG, 'mixed@acme.test']));
  });

  it('pins the single matching contact with FOR KEY SHARE before returning it', async () => {
    selectRowsMock.mockReturnValue([{ id: 'ct-1' }]);

    const result = await resolveEmailRequester(ORG, 'jane@acme.test', 'Jane');

    expect(result).toEqual({ kind: 'contact', contactId: 'ct-1' });
    const locking = calls.filter((c) => c.forShare === 'key share');
    expect(locking).toHaveLength(1);
    expect(locking[0]!.params).toEqual(expect.arrayContaining(['ct-1']));
  });

  it("returns none/'shared-mailbox' for a shared mailbox and creates nothing", async () => {
    selectRowsMock.mockReturnValue([{ id: 'ct-a' }, { id: 'ct-b' }]);

    const result = await resolveEmailRequester(ORG, 'support@acme.test', 'Acme Support');

    // The REASON is the point: the caller writes it into
    // ticket_email_inbound.error, which is the only place an operator can
    // learn why a ticket came in unattributed.
    expect(result).toEqual({ kind: 'none', reason: 'shared-mailbox' });
    expect(createContactMock).not.toHaveBeenCalled();
    // No guess by display name or by age, and no FOR KEY SHARE on a row we
    // are not going to link.
    expect(calls.some((c) => c.forShare)).toBe(false);
  });
  it('returns none/\'vanished\' when the matched contact disappears under the lock', async () => {
    // The probe saw a row; the FOR KEY SHARE re-read sees none — a DELETE
    // committed in between. Returning `ct-1` anyway would hand createTicket a
    // dangling FK and fail the WHOLE email (the ticket is the important part).
    selectRowsMock.mockReturnValueOnce([{ id: 'ct-1' }]).mockReturnValueOnce([]);

    const result = await resolveEmailRequester(ORG, 'gone@acme.test', 'Gone');

    expect(result).toEqual({ kind: 'none', reason: 'vanished' });
    expect(createContactMock).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
  ])("returns none/'unusable-address' for an %s From, before taking any lock", async (_label, from) => {
    const result = await resolveEmailRequester(ORG, from, null);

    expect(result).toEqual({ kind: 'none', reason: 'unusable-address' });
    // Not merely "no contact created" — NOTHING was issued. A lock keyed on
    // `<org>:` would serialise every malformed message in the org against
    // each other for the rest of the worker transaction.
    expect(calls).toHaveLength(0);
    expect(createContactMock).not.toHaveBeenCalled();
  });

  it('trims surrounding whitespace before both the lock key and the probe', async () => {
    // Real From headers arrive padded (`From: " Jane " < Jane@Acme.Test >`).
    // If the lock key and the probe disagreed about the spelling, the lock
    // would guard a key nothing else uses.
    selectRowsMock.mockReturnValue([{ id: 'ct-1' }]);

    await resolveEmailRequester(ORG, '  Jane@Acme.Test  ', 'Jane');

    expect(calls[0]!.params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG}:jane@acme.test`]);
    const probe = calls.find((c) => c.kind === 'select')!;
    expect(probe.params).toEqual(expect.arrayContaining([ORG, 'jane@acme.test']));
  });
});
