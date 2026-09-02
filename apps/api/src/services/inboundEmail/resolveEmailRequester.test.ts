/**
 * #3258 W03 — inbound-email requester resolution onto `contacts`.
 *
 * These assertions are on the COMPILED SQL and the real call arguments, not on
 * "a builder was called": a WHERE built against a mocked table object compiles
 * to something that asserts nothing (memory: vacuous Drizzle where-clause
 * assertions). The three behaviours that matter are all invisible to a
 * builder-shape assertion:
 *
 *  1. the advisory lock is taken FIRST, before the probe — the inbound worker
 *     runs at concurrency 5, so two first messages from one new sender would
 *     otherwise both see "no contact" and both create one;
 *  2. a shared mailbox (several contacts on one address) resolves to
 *     `ambiguous` — never a guess by display name (spoofable) or by age, and
 *     never a fresh duplicate;
 *  3. the matched contact is pinned with FOR KEY SHARE before the caller
 *     writes a ticket FK against it.
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

import { resolveEmailRequester } from './resolveOrg';

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
    expect(calls[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(/i);
    // Keyed on the org AND the normalized address — a lock on the address
    // alone would serialise unrelated tenants.
    expect(calls[0]!.params).toEqual([`${ORG}:jane@acme.test`]);
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
    // Nothing in this path may touch the auth table any more.
    expect(calls.some((c) => c.sql.includes('portal_users'))).toBe(false);
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

  it('returns ambiguous for a shared mailbox and creates nothing', async () => {
    selectRowsMock.mockReturnValue([{ id: 'ct-a' }, { id: 'ct-b' }]);

    const result = await resolveEmailRequester(ORG, 'support@acme.test', 'Acme Support');

    expect(result).toEqual({ kind: 'ambiguous' });
    expect(createContactMock).not.toHaveBeenCalled();
    // No guess by display name or by age, and no FOR KEY SHARE on a row we
    // are not going to link.
    expect(calls.some((c) => c.forShare)).toBe(false);
  });
});
