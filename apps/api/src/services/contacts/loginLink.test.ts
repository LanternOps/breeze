/**
 * #3258 follow-up — the shared "a LOGIN gets the org's CONTACT" resolver.
 *
 * Extracted from `routes/orgPortalUsers.resolveInviteContact` so the two paths
 * that were still minting contact-less `portal_users` rows (Entra SSO
 * provisioning, the Outlook add-in) resolve the person the SAME way the invite
 * does — same advisory lock, same shared-mailbox refusal, same role union.
 *
 * The executor is injected rather than mocked at the module boundary, so these
 * assertions run against REAL drizzle column objects: a compiled-SQL assertion
 * is the only kind that can tell `org_id = $1` from a where clause that forgot
 * the org and would read another tenant's contacts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { createContactMock, updateContactMock } = vi.hoisted(() => ({
  createContactMock: vi.fn(),
  updateContactMock: vi.fn(),
}));

vi.mock('./crud', async () => {
  const actual = await vi.importActual<typeof import('./crud')>('./crud');
  return { ...actual, createContact: createContactMock, updateContact: updateContactMock };
});

import { linkLoginToContact } from './loginLink';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import type { ContactExecutor } from './crud';

const ORG_ID = '7c0a1f7e-1111-4222-8333-444455556666';
const dialect = new PgDialect();
const compile = (statement: SQL) => dialect.sqlToQuery(statement as never);

interface Recorder {
  exec: ContactExecutor;
  executes: SQL[];
  wheres: SQL[];
  limits: number[];
}

/**
 * A minimal drizzle-shaped executor. `select().from().where().limit()` is the
 * exact chain the resolver uses; anything else throws rather than silently
 * resolving, so a shape change surfaces as a failure instead of an undefined.
 */
function recorder(rows: Array<Array<Record<string, unknown>>>): Recorder {
  const executes: SQL[] = [];
  const wheres: SQL[] = [];
  const limits: number[] = [];
  const queue = [...rows];
  const exec = {
    execute: (statement: SQL) => {
      executes.push(statement);
      return Promise.resolve([]);
    },
    select: () => ({
      from: () => ({
        where: (clause: SQL) => {
          wheres.push(clause);
          return {
            limit: (n: number) => {
              limits.push(n);
              return Promise.resolve(queue.shift() ?? []);
            },
          };
        },
      }),
    }),
  } as unknown as ContactExecutor;
  return { exec, executes, wheres, limits };
}

const actor = { userId: 'u-1' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('linkLoginToContact', () => {
  it('refuses an unusable address BEFORE taking the lock', async () => {
    // Locking on `<org>:` would serialise every address-less login in the org
    // against each other for the rest of the transaction, and there is nothing
    // to look up anyway.
    const r = recorder([]);
    const result = await linkLoginToContact(r.exec, { orgId: ORG_ID, email: '   ', name: 'X', actor });

    expect(result).toEqual({ contactId: null, outcome: 'unusable-address' });
    expect(r.executes).toHaveLength(0);
    expect(r.wheres).toHaveLength(0);
    expect(createContactMock).not.toHaveBeenCalled();
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('refuses a null address the same way', async () => {
    const r = recorder([]);
    expect(await linkLoginToContact(r.exec, { orgId: ORG_ID, email: null, actor })).toEqual({
      contactId: null,
      outcome: 'unusable-address',
    });
    expect(r.executes).toHaveLength(0);
  });

  it('takes the SAME namespaced advisory lock inbound email takes, on the normalized key', async () => {
    const r = recorder([[]]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });

    await linkLoginToContact(r.exec, { orgId: ORG_ID, email: '  Fresh@Acme.Example ', actor });

    expect(r.executes).toHaveLength(1);
    const { sql: lockSql, params } = compile(r.executes[0]!);
    expect(lockSql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
    expect(params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG_ID}:fresh@acme.example`]);
  });

  it('scopes the lookup to the org AND the lower-cased address', async () => {
    const r = recorder([[{ id: 'ct-1', roles: ['portal'] }]]);

    await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'Known@Acme.Example', actor });

    expect(r.wheres).toHaveLength(1);
    const { sql: whereSql, params } = compile(r.wheres[0]!);
    // The org predicate is the tenant boundary — a where clause that lost it
    // would link a login to another tenant's contact.
    expect(whereSql).toMatch(/"org_id"\s*=\s*\$\d/i);
    expect(whereSql).toMatch(/lower\("contacts"\."email"\)\s*=\s*\$\d/i);
    expect(params).toEqual([ORG_ID, 'known@acme.example']);
    // limit(2) is all the arithmetic this needs: two rows means "at least two".
    expect(r.limits).toEqual([2]);
  });

  it('links the one existing contact and unions the portal role it lacked', async () => {
    const r = recorder([[{ id: 'ct-1', roles: ['billing'] }]]);

    const result = await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'known@acme.example', actor });

    expect(result).toEqual({ contactId: 'ct-1', outcome: 'linked' });
    expect(createContactMock).not.toHaveBeenCalled();
    expect(updateContactMock).toHaveBeenCalledTimes(1);
    const [, contactId, orgId, patch] = updateContactMock.mock.calls[0]!;
    expect(contactId).toBe('ct-1');
    expect(orgId).toBe(ORG_ID);
    // A UNION, never a replace: granting a login does not stop someone being
    // the billing contact.
    expect((patch as { roles: string[] }).roles.slice().sort()).toEqual(['billing', 'portal']);
  });

  it('writes nothing when the contact ALREADY holds the portal role', async () => {
    const r = recorder([[{ id: 'ct-1', roles: ['portal', 'technical'] }]]);

    const result = await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'known@acme.example', actor });

    expect(result).toEqual({ contactId: 'ct-1', outcome: 'linked' });
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('treats a null roles column as empty rather than throwing', async () => {
    const r = recorder([[{ id: 'ct-1', roles: null }]]);

    await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'known@acme.example', actor });

    expect((updateContactMock.mock.calls[0]![3] as { roles: string[] }).roles).toEqual(['portal']);
  });

  it('creates a portal-role contact when the org has none for the address', async () => {
    const r = recorder([[]]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });

    const result = await linkLoginToContact(r.exec, {
      orgId: ORG_ID,
      email: 'Fresh@Acme.Example',
      name: 'Fresh Cust',
      actor,
    });

    expect(result).toEqual({ contactId: 'ct-made', outcome: 'created' });
    const [, input, passedActor] = createContactMock.mock.calls[0]!;
    expect(input).toMatchObject({
      orgId: ORG_ID,
      email: 'fresh@acme.example',
      name: 'Fresh Cust',
      roles: ['portal'],
    });
    expect(passedActor).toEqual(actor);
  });

  it('passes a null name through rather than inventing one', async () => {
    const r = recorder([[]]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });

    await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'fresh@acme.example', actor });

    expect(createContactMock.mock.calls[0]![1]).toMatchObject({ name: null });
  });

  it('leaves a shared mailbox UNLINKED instead of guessing which person it is', async () => {
    // contacts_org_email_idx is deliberately non-unique — a shared support@ is
    // a real, supported state. Picking one would silently hand that person's
    // ticket history to whoever got the login.
    const r = recorder([[{ id: 'ct-a', roles: [] }, { id: 'ct-b', roles: [] }]]);

    const result = await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'support@acme.example', actor });

    expect(result).toEqual({ contactId: null, outcome: 'ambiguous' });
    expect(createContactMock).not.toHaveBeenCalled();
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('passes a system actor (userId null) straight through to the create', async () => {
    // The Entra exchange has no acting Breeze user — the login provisions
    // itself from a token, so `created_by` is genuinely null.
    const r = recorder([[]]);
    createContactMock.mockResolvedValueOnce({ id: 'ct-made' });

    await linkLoginToContact(r.exec, { orgId: ORG_ID, email: 'sso@acme.example', actor: { userId: null } });

    expect(createContactMock.mock.calls[0]![2]).toEqual({ userId: null });
  });
});
