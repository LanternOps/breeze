/**
 * Portal registration W1 (#11378): invite a contact to the customer portal.
 *
 * The planner is pure and table-driven. The binder runs against an injected
 * drizzle-shaped executor, so its where clauses are compiled with the REAL
 * column objects: only a compiled-SQL assertion can tell `org_id = $1` from a
 * where clause that forgot the org and would bind another tenant's contact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { portalUsers } from '../../db/schema/portal';
import type { SQL } from 'drizzle-orm';

const { updateContactMock } = vi.hoisted(() => ({ updateContactMock: vi.fn() }));

vi.mock('./crud', async () => {
  const actual = await vi.importActual<typeof import('./crud')>('./crud');
  return { ...actual, updateContact: updateContactMock };
});

import {
  planContactInvite,
  portalLoginEmailEquals,
  bindContactLoginForInvite,
  loadOrgContactsForPortalInvite,
  lockPortalInviteAddresses,
  ContactGoneError,
  ContactEmailChangedError,
  PortalLoginChangedError,
  type InviteLoginCandidate,
  type InviteableContact,
} from './portalInvite';
import { PortalAccountTransitionError } from '../portalAccountState';
import { INBOUND_CONTACT_LOCK_NAMESPACE } from '../inboundEmail/resolveOrg';
import type { ContactExecutor } from './crud';

const ORG = '7c0a1f7e-1111-4222-8333-444455556666';
const C = '11111111-1111-4111-8111-111111111111';
const D = '22222222-2222-4222-8222-222222222222';
const dialect = new PgDialect();
const compile = (statement: SQL) => dialect.sqlToQuery(statement as never);

let seq = 0;
function login(over: Partial<InviteLoginCandidate> = {}): InviteLoginCandidate {
  seq += 1;
  return {
    id: `pu-${seq}`,
    email: 'ada@x.test',
    contactId: null,
    authMethod: 'password',
    status: 'invited',
    passwordHash: null,
    createdAt: new Date(2026, 0, seq),
    authEpoch: 1,
    browserAccess: 'granted',
    hasExternalIdentity: false,
    ...over,
  };
}

describe('planContactInvite', () => {
  const E = 'ada@x.test';

  it('no candidates gives create', () => {
    expect(planContactInvite(C, E, [])).toEqual({ action: 'create' });
  });

  it('a pending password row bound to C gives reuse/kept', () => {
    const l = login({ contactId: C });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'reuse', login: l, contactLink: 'kept' });
  });

  it('a legacy status=active row without a password, bound to C, is pending and gives reuse/kept', () => {
    const l = login({ contactId: C, status: 'active', passwordHash: null });
    expect(planContactInvite(C, E, [l])).toMatchObject({ action: 'reuse', contactLink: 'kept' });
  });

  it('an active row with a password bound to C gives has_access/active', () => {
    const l = login({ contactId: C, status: 'active', passwordHash: 'h' });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'has_access', login: l, reason: 'active' });
  });

  it('a disabled row bound to C gives has_access/disabled', () => {
    const l = login({ contactId: C, status: 'disabled', passwordHash: 'h' });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'has_access', login: l, reason: 'disabled' });
  });

  it('a pending row bound to C under the old address gives has_access/login_email_differs', () => {
    const l = login({ contactId: C, email: 'old@x.test' });
    expect(planContactInvite(C, 'new@x.test', [l])).toEqual({ action: 'has_access', login: l, reason: 'login_email_differs' });
  });

  it('a row with the address bound to another contact gives conflict', () => {
    const l = login({ contactId: D });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'conflict', login: l });
  });

  it('an unbound pending row with the address gives reuse/direct', () => {
    const l = login();
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'reuse', login: l, contactLink: 'direct' });
  });

  it('an unbound active row with a password gives has_access/active (and so is never bound)', () => {
    const l = login({ status: 'active', passwordHash: 'h' });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'has_access', login: l, reason: 'active' });
  });

  it('an unbound disabled row gives has_access/disabled', () => {
    const l = login({ status: 'disabled' });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'has_access', login: l, reason: 'disabled' });
  });

  it('an Entra-only row with the address gives has_access/external_identity', () => {
    const l = login({ authMethod: 'entra', status: 'active' });
    expect(planContactInvite(C, E, [l])).toEqual({ action: 'has_access', login: l, reason: 'external_identity' });
  });

  it('an Entra row bound to C and no password row gives has_access/external_identity', () => {
    const l = login({ authMethod: 'entra', contactId: C, email: 'other@x.test' });
    expect(planContactInvite(C, E, [l])).toMatchObject({ action: 'has_access', reason: 'external_identity' });
  });

  it('a password row bound to C plus an Entra twin gives reuse/kept (password wins)', () => {
    const p = login({ contactId: C });
    const x = login({ authMethod: 'entra', contactId: C });
    expect(planContactInvite(C, E, [x, p])).toEqual({ action: 'reuse', login: p, contactLink: 'kept' });
  });

  it('matches a mixed-case stored address against the normalized one', () => {
    const l = login({ email: 'Ada@X.test' });
    expect(planContactInvite(C, 'ada@x.test', [l])).toMatchObject({ action: 'reuse', contactLink: 'direct' });
  });

  it('several rows bound to C: an active row with a password outranks a pending one', () => {
    const pending = login({ contactId: C, createdAt: new Date(2026, 5, 1) });
    const active = login({ contactId: C, status: 'active', passwordHash: 'h', createdAt: new Date(2026, 0, 1) });
    expect(planContactInvite(C, E, [pending, active])).toMatchObject({ action: 'has_access', reason: 'active', login: active });
  });

  it('several rows bound to C: a pending row outranks a disabled one', () => {
    const disabled = login({ contactId: C, status: 'disabled' });
    const pending = login({ contactId: C });
    expect(planContactInvite(C, E, [disabled, pending])).toMatchObject({ action: 'reuse', login: pending });
  });

  it('several unbound rows with the address: the newest decides', () => {
    const older = login({ status: 'disabled', createdAt: new Date(2025, 0, 1) });
    const newer = login({ createdAt: new Date(2026, 0, 1) });
    expect(planContactInvite(C, E, [older, newer])).toMatchObject({ action: 'reuse', contactLink: 'direct', login: newer });
  });

  it('a conflict outranks an unbound row with the same address (never guess)', () => {
    const bound = login({ contactId: D });
    const unbound = login();
    expect(planContactInvite(C, E, [unbound, bound])).toMatchObject({ action: 'conflict', login: bound });
  });
});

// ── binder ──────────────────────────────────────────────────────────────────

interface Recorder {
  exec: ContactExecutor;
  executes: SQL[];
  wheres: SQL[];
  selections: Array<Record<string, unknown>>;
  forStrengths: string[];
  inserts: Array<Record<string, unknown>>;
  updates: Array<{ set: Record<string, unknown>; where: SQL }>;
  order: string[];
}

/**
 * A drizzle-shaped executor. Each select consumes the next queued result, in
 * order; insert/update record what they were given.
 */
function recorder(
  selects: Array<Array<Record<string, unknown>>>,
  updateReturning: Array<Record<string, unknown>> = [{ id: 'updated', authEpoch: 8 }],
): Recorder {
  const queue = [...selects];
  const rec: Recorder = { exec: null as never, executes: [], wheres: [], selections: [], forStrengths: [], inserts: [], updates: [], order: [] };
  rec.exec = {
    execute: (statement: SQL) => {
      rec.executes.push(statement);
      rec.order.push('lock');
      return Promise.resolve([]);
    },
    select: (cols: Record<string, unknown>) => ({
      from: () => ({
        where: (clause: SQL) => {
          rec.selections.push(cols);
          rec.wheres.push(clause);
          let settled: Promise<unknown> | null = null;
          const result = () => {
            if (!settled) {
              rec.order.push('select');
              settled = Promise.resolve(queue.shift() ?? []);
            }
            return settled;
          };
          const leaf: Record<string, unknown> = {
            for: (strength: string) => { rec.forStrengths.push(strength); return leaf; },
            limit: () => leaf,
            orderBy: () => leaf,
            then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => result().then(res, rej),
          };
          return leaf;
        },
      }),
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        rec.inserts.push(values);
        rec.order.push('insert');
        return { returning: () => Promise.resolve([{ id: 'pu-new', authEpoch: 1 }]) };
      },
    }),
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: SQL) => {
          rec.updates.push({ set, where });
          rec.order.push('update');
          return { returning: () => Promise.resolve(updateReturning) };
        },
      }),
    }),
  } as unknown as ContactExecutor;
  return rec;
}

const contact: InviteableContact = { id: C, orgId: ORG, siteId: null, name: 'Ada', email: 'Ada@X.test' };
const NOW = new Date('2026-11-08T12:00:00Z');
const bindInput = (over: Partial<Parameters<typeof bindContactLoginForInvite>[1]> = {}) => ({
  orgId: ORG,
  contact,
  normalizedEmail: 'ada@x.test',
  name: null,
  actor: { userId: 'tech-1' },
  now: NOW,
  ...over,
});
const contactRow = (over: Record<string, unknown> = {}) => ({ id: C, email: 'ada@x.test', roles: [] as string[], ...over });

beforeEach(() => {
  vi.clearAllMocks();
  updateContactMock.mockResolvedValue({ id: C });
});

describe('bindContactLoginForInvite', () => {
  it('takes the inbound advisory lock on (org, normalized email) before any read', async () => {
    const r = recorder([[contactRow()], []]);
    await bindContactLoginForInvite(r.exec, bindInput());

    expect(r.order[0]).toBe('lock');
    const { sql: lockSql, params } = compile(r.executes[0]!);
    expect(lockSql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$\d\), hashtext\(\$\d\)\)/i);
    expect(params).toEqual([INBOUND_CONTACT_LOCK_NAMESPACE, `${ORG}:ada@x.test`]);
  });

  it('re-reads the contact by id AND org with FOR KEY SHARE and throws ContactGoneError when it is gone', async () => {
    const r = recorder([[]]);
    await expect(bindContactLoginForInvite(r.exec, bindInput())).rejects.toBeInstanceOf(ContactGoneError);

    const { sql: whereSql, params } = compile(r.wheres[0]!);
    expect(whereSql).toMatch(/"contacts"\."id"\s*=\s*\$\d/i);
    expect(whereSql).toMatch(/"contacts"\."org_id"\s*=\s*\$\d/i);
    expect(params).toEqual([C, ORG]);
    expect(r.forStrengths).toEqual(['key share']);
    expect(r.inserts).toHaveLength(0);
    expect(r.updates).toHaveLength(0);
  });

  it('throws ContactEmailChangedError when the locked contact no longer carries the invite address', async () => {
    const r = recorder([[contactRow({ email: 'someone-else@x.test' })]]);
    await expect(bindContactLoginForInvite(r.exec, bindInput())).rejects.toBeInstanceOf(ContactEmailChangedError);
    expect(r.inserts).toHaveLength(0);
    expect(r.updates).toHaveLength(0);
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('reads candidates in this org by contact OR lower-cased address', async () => {
    const r = recorder([[contactRow()], []]);
    await bindContactLoginForInvite(r.exec, bindInput());

    const { sql: whereSql, params } = compile(r.wheres[1]!);
    expect(whereSql).toMatch(/"portal_users"\."org_id"\s*=\s*\$\d/i);
    expect(whereSql).toMatch(/"portal_users"\."contact_id"\s*=\s*\$\d/i);
    expect(whereSql).toMatch(/lower\("portal_users"\."email"\)\s*=\s*\$\d/i);
    expect(params).toEqual([ORG, C, 'ada@x.test']);
  });

  it('create inserts the state module\'s initial msp_invite state (invited + browser access) bound to the contact, and returns the epoch', async () => {
    const r = recorder([[contactRow()], []]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());

    expect(decision).toEqual({ kind: 'invite', portalUserId: 'pu-new', email: 'ada@x.test', authEpoch: 1, created: true, contactLink: 'direct' });
    expect(r.inserts).toEqual([{
      orgId: ORG,
      email: 'ada@x.test',
      name: 'Ada',
      passwordHash: null,
      authMethod: 'password',
      status: 'invited',
      browserAccess: 'granted',
      invitedBy: 'tech-1',
      invitedAt: NOW,
      contactId: C,
    }]);
    expect(r.updates).toHaveLength(0);
  });

  it('create prefers the name the MSP typed over the contact name', async () => {
    const r = recorder([[contactRow()], []]);
    await bindContactLoginForInvite(r.exec, bindInput({ name: 'Ada L.' }));
    expect(r.inserts[0]!.name).toBe('Ada L.');
  });

  it('reuse/direct writes the state module target and contactId, guarded by the epoch it read, and returns the new epoch', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: null, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 7, browserAccess: 'granted', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());

    expect(decision).toEqual({ kind: 'invite', portalUserId: 'pu-1', email: 'ada@x.test', authEpoch: 8, created: false, contactLink: 'direct' });
    expect(r.inserts).toHaveLength(0);
    expect(r.updates).toHaveLength(1);
    const { set, where } = r.updates[0]!;
    expect(set).toMatchObject({ status: 'invited', browserAccess: 'granted', invitedBy: 'tech-1', invitedAt: NOW, updatedAt: NOW, contactId: C });
    expect(compile(set.authEpoch as SQL).sql).toMatch(/"auth_epoch"\s*\+\s*1/);
    const compiled = compile(where);
    expect(compiled.sql).toMatch(/"portal_users"\."id"\s*=\s*\$\d/);
    expect(compiled.sql).toMatch(/"portal_users"\."org_id"\s*=\s*\$\d/);
    // Optimistic concurrency, as every other MSP writer: the epoch that was read.
    expect(compiled.sql).toMatch(/"portal_users"\."auth_epoch"\s*=\s*\$\d/);
    expect(compiled.params).toEqual(['pu-1', ORG, 7]);
  });

  it('a legacy credential-less ACTIVE row is moved to invited (the msp_invite target), not left active', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: C, authMethod: 'password', status: 'active', passwordHash: null, createdAt: NOW, authEpoch: 3, browserAccess: 'granted', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]]);
    await bindContactLoginForInvite(r.exec, bindInput());
    expect(r.updates[0]!.set).toMatchObject({ status: 'invited', browserAccess: 'granted' });
  });

  it('throws PortalLoginChangedError when the epoch guard matches nothing (changed since the read), before any contact write', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: null, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 7, browserAccess: 'granted', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]], []);
    await expect(bindContactLoginForInvite(r.exec, bindInput())).rejects.toBeInstanceOf(PortalLoginChangedError);
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('an unknown stored browser_access fails closed (the state module refuses), writing nothing', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: C, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 7, browserAccess: 'maybe', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]]);
    await expect(bindContactLoginForInvite(r.exec, bindInput())).rejects.toBeInstanceOf(PortalAccountTransitionError);
    expect(r.updates).toHaveLength(0);
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('reuse/kept leaves the existing binding as it is', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: C, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 2, browserAccess: 'granted', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());

    expect(decision).toMatchObject({ kind: 'invite', created: false, contactLink: 'kept' });
    expect(r.updates[0]!.set.contactId).toBe(C);
  });

  it.each([
    ['active', { contactId: C, status: 'active', passwordHash: 'h' }, { kind: 'already_has_access', reason: 'active' }],
    ['disabled', { contactId: C, status: 'disabled' }, { kind: 'already_has_access', reason: 'disabled' }],
    ['external identity', { authMethod: 'entra', status: 'active' }, { kind: 'already_has_access', reason: 'external_identity' }],
    ['login email differs', { contactId: C, email: 'old@x.test' }, { kind: 'already_has_access', reason: 'login_email_differs' }],
    ['conflict', { contactId: D }, { kind: 'email_bound_to_other_contact' }],
    // The planner picks this password row; the state module refuses it as
    // identity-managed (W2), which the invite API reports as external_identity.
    ['password row carrying an Entra identity', { contactId: C, hasExternalIdentity: true }, { kind: 'already_has_access', reason: 'external_identity' }],
  ])('%s performs no insert, update, or contact write', async (_label, over, expected) => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: null, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 1, browserAccess: 'granted', hasExternalIdentity: false, ...over };
    const r = recorder([[contactRow()], [existing]]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());

    expect(decision).toEqual({ ...expected, portalUserId: 'pu-1' });
    expect(r.inserts).toHaveLength(0);
    expect(r.updates).toHaveLength(0);
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  // ---- W3 identities release B: the external-identity fact comes from
  // portal_user_identities (portalUserHasIdentitySql), never entra_oid. ----

  it('an account with an identity row is identity-managed even when entra_oid is NULL', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: C, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 1, browserAccess: 'granted', entraOid: null, hasExternalIdentity: true };
    const r = recorder([[contactRow()], [existing]]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());
    expect(decision).toEqual({ kind: 'already_has_access', portalUserId: 'pu-1', reason: 'external_identity' });
    expect(r.updates).toHaveLength(0);
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('an identity on ANOTHER user does not make this user identity-managed', async () => {
    const existing = { id: 'pu-1', email: 'ada@x.test', contactId: C, authMethod: 'password', status: 'invited', passwordHash: null, createdAt: NOW, authEpoch: 2, browserAccess: 'granted', hasExternalIdentity: false };
    const r = recorder([[contactRow()], [existing]]);
    const decision = await bindContactLoginForInvite(r.exec, bindInput());
    expect(decision).toMatchObject({ kind: 'invite', portalUserId: 'pu-1' });
    // The candidate read (2nd select) asks the DB per row, correlated to THIS
    // row's id even in a single-table select (#9692), and no longer reads entra_oid.
    const cols = r.selections[1]!;
    expect(cols).not.toHaveProperty('entraOid');
    const text = new QueryBuilder().select({ id: portalUsers.id, has: cols.hasExternalIdentity as SQL }).from(portalUsers).toSQL().sql;
    expect(text).toMatch(/exists \(select 1 from "portal_user_identities" "\w+" where "\w+"\."portal_user_id" = "portal_users"\."id"\)/);
  });

  it("unions the 'portal' role only when missing", async () => {
    const r1 = recorder([[contactRow({ roles: ['billing'] })], []]);
    await bindContactLoginForInvite(r1.exec, bindInput());
    expect(updateContactMock).toHaveBeenCalledTimes(1);
    const [, contactId, orgId, patch, actor] = updateContactMock.mock.calls[0]!;
    expect(contactId).toBe(C);
    expect(orgId).toBe(ORG);
    expect((patch as { roles: string[] }).roles).toEqual(['billing', 'portal']);
    expect(actor).toEqual({ userId: 'tech-1' });

    updateContactMock.mockClear();
    const r2 = recorder([[contactRow({ roles: ['portal', 'technical'] })], []]);
    await bindContactLoginForInvite(r2.exec, bindInput());
    expect(updateContactMock).not.toHaveBeenCalled();
  });

  it('treats a null roles column as empty', async () => {
    const r = recorder([[contactRow({ roles: null })], []]);
    await bindContactLoginForInvite(r.exec, bindInput());
    expect((updateContactMock.mock.calls[0]![3] as { roles: string[] }).roles).toEqual(['portal']);
  });
});

describe('lockPortalInviteAddresses', () => {
  it('locks each distinct address once, in sorted order (one global order cannot deadlock)', async () => {
    const r = recorder([]);
    await lockPortalInviteAddresses(r.exec, ORG, ['b@x.test', 'a@x.test', 'b@x.test']);
    expect(r.executes.map((s) => compile(s).params[1])).toEqual([`${ORG}:a@x.test`, `${ORG}:b@x.test`]);
  });
});

describe('loadOrgContactsForPortalInvite', () => {
  it('reads by org AND id list', async () => {
    const r = recorder([[{ id: C, orgId: ORG, siteId: null, name: 'Ada', email: 'ada@x.test' }]]);
    const rows = await loadOrgContactsForPortalInvite(r.exec, ORG, [C, D]);
    expect(rows).toHaveLength(1);
    const { sql: whereSql, params } = compile(r.wheres[0]!);
    expect(whereSql).toMatch(/"contacts"\."org_id"\s*=\s*\$\d/i);
    expect(whereSql).toMatch(/"contacts"\."id"\s+in\s+\(\$\d,\s*\$\d\)/i);
    expect(params).toEqual([ORG, C, D]);
  });

  it('does not query for an empty id list', async () => {
    const r = recorder([]);
    expect(await loadOrgContactsForPortalInvite(r.exec, ORG, [])).toEqual([]);
    expect(r.wheres).toHaveLength(0);
  });
});

describe("portalLoginEmailEquals (#11529)", () => {
  it("compares lower(email) against the lower-cased, trimmed address", () => {
    const q = compile(portalLoginEmailEquals("  Ada@X.Test "));
    expect(q.sql).toContain("lower(\"portal_users\".\"email\") = $1");
    expect(q.params).toEqual(["ada@x.test"]);
  });
});
