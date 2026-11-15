/**
 * Unit tests for the shared identity writer (portal registration W8 #11385,
 * plan Task 3): statement order (advisory lock, account, identity), the
 * account rule, the epoch rule, the skips, after-commit purges, Restore and
 * the OD3 remove action, over a scripted Drizzle mock. The two-connection
 * races and the session refusal are proven against real Postgres in
 * __tests__/integration/portalDirectoryIdentityDisable.integration.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

type Step = [string, unknown[]];
interface Call { op: 'select' | 'insert' | 'update' | 'delete' | 'execute'; args: unknown[]; steps: Step[]; depth: number }

const h = vi.hoisted(() => {
  const calls: Call[] = [];
  const results: unknown[] = [];
  const txDepth = { current: 0 };
  const held = { current: false };
  function builder(op: Call['op'], args: unknown[]): unknown {
    const call: Call = { op, args, steps: [], depth: txDepth.current };
    calls.push(call);
    const proxy: unknown = new Proxy(() => undefined, {
      get(_target, prop) {
        if (prop === 'then') {
          const next = results.length > 0 ? results.shift() : [];
          return (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            next instanceof Error ? reject(next) : resolve(next);
        }
        return (...stepArgs: unknown[]) => {
          call.steps.push([String(prop), stepArgs]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return { calls, results, txDepth, held, builder };
});

vi.mock('../../db', () => ({
  db: {
    select: (...a: unknown[]) => h.builder('select', a),
    insert: (...a: unknown[]) => h.builder('insert', a),
    update: (...a: unknown[]) => h.builder('update', a),
    delete: (...a: unknown[]) => h.builder('delete', a),
    execute: (...a: unknown[]) => h.builder('execute', a),
  },
  hasDbAccessContext: vi.fn(() => h.held.current || h.txDepth.current > 0),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
}));

const policy = vi.hoisted(() => ({ mode: 'allowed' as 'allowed' | 'sso_only', calls: 0 }));
vi.mock('../portalAccessPolicy', () => ({
  resolvePortalAccessPolicy: vi.fn(async () => {
    policy.calls += 1;
    return { effective: { passwordMode: { value: policy.mode } } };
  }),
}));

const purge = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('../../routes/portal/helpers', () => ({
  purgePortalSessionsForUsers: vi.fn(async (ids: string[]) => {
    purge.order.push(`portal:${ids.join(',')}:depth${h.txDepth.current}`);
    return 1;
  }),
}));
vi.mock('../clientAiSessionStore', () => ({
  purgeClientAiSessionsForUsers: vi.fn(async (_redis: unknown, ids: string[]) => {
    purge.order.push(`clientAi:${ids.join(',')}:depth${h.txDepth.current}`);
    return 1;
  }),
}));
const fakeRedis = vi.hoisted(() => ({ fake: 'redis' }));
vi.mock('../redis', () => ({ getRedis: vi.fn(() => fakeRedis) }));
vi.mock('../auditRequestTracking', () => ({ markRequestAuditWritten: vi.fn() }));

import { auditLogs, portalDirectoryActions, portalUserIdentities, portalUsers } from '../../db/schema';
import { purgePortalSessionsForUsers } from '../../routes/portal/helpers';
import { purgeClientAiSessionsForUsers } from '../clientAiSessionStore';
import { markRequestAuditWritten } from '../auditRequestTracking';
import {
  PortalDirectoryIdentityError,
  disablePortalIdentity,
  previewAccountEffect,
  removeDisabledPortalIdentity,
  restorePortalIdentity,
  retryPendingPurges,
} from './identityDisable';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const PU = '5c1f2e3d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const IDENT = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b';
const ACTION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const RUN = '9f8e7d6c-5b4a-4398-8776-655443322110';
const ACTOR = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const TID = '11111111-2222-4333-8444-555555555555';
const CHAIN = `entra:${TID}:conn:1:${ORG}`;
const NOW = new Date('2027-02-01T12:00:00.000Z');

function stepsOf(call: Call | undefined, name: string): unknown[][] {
  return (call?.steps ?? []).filter(([n]) => n === name).map(([, a]) => a);
}
function firstArg(call: Call | undefined, name: string): Record<string, unknown> {
  return stepsOf(call, name)[0]?.[0] as Record<string, unknown>;
}
const writes = () => h.calls.filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete');
const updatesOf = (table: unknown) => h.calls.filter((c) => c.op === 'update' && c.args[0] === table);
const inserts = () => h.calls.filter((c) => c.op === 'insert');
const sqlText = (call: Call) => new PgDialect().sqlToQuery(call.args[0] as SQL);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
}

function account(over: Record<string, unknown> = {}) {
  return {
    id: PU, status: 'active', browserAccess: 'granted', authMethod: 'entra', passwordHash: null, disabledBy: null, ...over,
  };
}
function identity(over: Record<string, unknown> = {}) {
  return {
    id: IDENT, orgId: ORG, portalUserId: PU, provider: 'entra', entraTenantId: TID,
    disabledAt: null, disabledReason: null, disabledBlockers: [], directoryChain: CHAIN, directoryRearmSince: null,
    directoryLastRunId: RUN,
    ...over,
  };
}
const owner = (over: Record<string, unknown> = {}) => ({ portalUserId: PU, provider: 'entra', subject: 'oid-1', entraTenantId: TID, ...over });
const heldAction = (over: Record<string, unknown> = {}) => ({ id: ACTION, identityId: IDENT, runId: RUN, status: 'held', ...over });

const directoryInput = { orgId: ORG, identityId: IDENT, blocker: 'entra_directory' as const, reason: 'account_disabled' as const, actionId: ACTION, now: NOW };

/** Script a directory disable up to the account rule: lock, owner, account, identity, action, identity update. */
function scriptDisable(opts: { account?: Record<string, unknown>; identity?: Record<string, unknown>; otherUsable?: number; withAction?: boolean }) {
  const withAction = opts.withAction ?? true;
  if (withAction) h.results.push([]);                         // advisory lock
  h.results.push([owner()]);                                  // identity owner (unlocked)
  h.results.push([account(opts.account)]);                    // account FOR UPDATE
  h.results.push([identity(opts.identity)]);                  // identity FOR UPDATE
  if (withAction) h.results.push([heldAction()]);             // action FOR UPDATE
  h.results.push([]);                                         // identity update
  h.results.push([{ n: opts.otherUsable ?? 0 }]);             // other usable identities
}

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  h.txDepth.current = 0;
  h.held.current = false;
  policy.mode = 'allowed';
  policy.calls = 0;
  purge.order.length = 0;
  vi.clearAllMocks();
});

describe('previewAccountEffect (D2, shared with the run store)', () => {
  it('disables the account only when nothing else signs in', () => {
    expect(previewAccountEffect({ otherUsableIdentities: 0, passwordUsable: false, status: 'active' }))
      .toEqual({ effect: 'identity_and_account', keepsPassword: false });
    expect(previewAccountEffect({ otherUsableIdentities: 0, passwordUsable: false, status: 'invited' }))
      .toEqual({ effect: 'identity_and_account', keepsPassword: false });
    expect(previewAccountEffect({ otherUsableIdentities: 0, passwordUsable: true, status: 'active' }))
      .toEqual({ effect: 'identity', keepsPassword: true });
    expect(previewAccountEffect({ otherUsableIdentities: 1, passwordUsable: false, status: 'active' }))
      .toEqual({ effect: 'identity', keepsPassword: false });
    expect(previewAccountEffect({ otherUsableIdentities: 1, passwordUsable: true, status: 'active' }))
      .toEqual({ effect: 'identity', keepsPassword: true });
  });

  it('an already-disabled account is never touched and keeps no password access', () => {
    expect(previewAccountEffect({ otherUsableIdentities: 0, passwordUsable: true, status: 'disabled' }))
      .toEqual({ effect: 'identity', keepsPassword: false });
  });
});

describe('disablePortalIdentity', () => {
  it('identity-only account: identity and account disabled, epoch bumped, both session stores purged', async () => { // RF3
    scriptDisable({});
    const out = await disablePortalIdentity(directoryInput);

    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: true, keepsPassword: false });
    const [idUpdate] = updatesOf(portalUserIdentities);
    expect(firstArg(idUpdate, 'set')).toMatchObject({
      disabledBlockers: ['entra_directory'], disabledAt: NOW, disabledReason: 'account_disabled',
    });
    const [accUpdate] = updatesOf(portalUsers);
    const accSet = firstArg(accUpdate, 'set');
    expect(accSet).toMatchObject({ status: 'disabled', browserAccess: 'granted', disabledBy: 'directory' });
    expect(accSet).toHaveProperty('authEpoch');
    // The action is applied in the transaction; sessions_purged_at after commit.
    const actionUpdates = updatesOf(portalDirectoryActions);
    expect(firstArg(actionUpdates[0], 'set')).toEqual({ status: 'applied', appliedAt: NOW });
    expect(actionUpdates[0]!.depth).toBe(1);
    expect(Object.keys(firstArg(actionUpdates[1], 'set'))).toEqual(['sessionsPurgedAt']);
    expect(purge.order).toEqual([`portal:${PU}:depth0`, `clientAi:${PU}:depth0`]);
    expect(purgeClientAiSessionsForUsers).toHaveBeenCalledWith(fakeRedis, [PU]);
    expect(policy.calls).toBe(0); // no hash: the password mode is never read
  });

  it('writes the audit row in the transaction with the D12 details', async () => {
    scriptDisable({});
    await disablePortalIdentity(directoryInput);
    const [audit] = inserts();
    expect(audit!.args[0]).toBe(auditLogs);
    expect(audit!.depth).toBe(1);
    expect(firstArg(audit, 'values')).toMatchObject({
      orgId: ORG,
      actorType: 'system',
      action: 'portal.directory.identity.disable',
      resourceType: 'portal_user',
      resourceId: PU,
      result: 'success',
      details: {
        identityId: IDENT, provider: 'entra', blocker: 'entra_directory', reason: 'account_disabled',
        runId: RUN, accountDisabled: true, keepsPassword: false,
      },
    });
    // A system row: never counted as the calling request's own audit.
    expect(markRequestAuditWritten).not.toHaveBeenCalled();
  });

  it('takes the (org, source) advisory lock first, then the account, then the identity, all in one transaction', async () => {
    scriptDisable({});
    await disablePortalIdentity(directoryInput);
    const ops = h.calls.slice(0, 5);
    expect(ops.map((c) => c.op)).toEqual(['execute', 'select', 'select', 'select', 'select']);
    const lock = sqlText(ops[0]!);
    expect(lock.sql).toMatch(/^select pg_advisory_xact_lock\(hashtext\(\$1\)\)$/i);
    expect(lock.params).toEqual([`portal-directory:${ORG}:entra`]);
    expect(ops[2]!.args[0]).toBeDefined();
    expect(stepsOf(ops[2], 'from')[0]![0]).toBe(portalUsers);
    expect(stepsOf(ops[2], 'for')[0]).toEqual(['update']);
    expect(stepsOf(ops[3], 'from')[0]![0]).toBe(portalUserIdentities);
    expect(stepsOf(ops[3], 'for')[0]).toEqual(['update']);
    expect(stepsOf(ops[4], 'from')[0]![0]).toBe(portalDirectoryActions);
    expect(h.calls.filter((c) => c.op !== 'update' || c.args[0] !== portalDirectoryActions || !('sessionsPurgedAt' in firstArg(c, 'set')))
      .every((c) => c.depth === 1)).toBe(true);
  });

  it('an action of an auto-apply run (pending) is applied like a held one', async () => {
    h.results.push([], [owner()], [account()], [identity()], [heldAction({ status: 'pending' })], [], [{ n: 0 }]);
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: true, keepsPassword: false });
    expect(firstArg(updatesOf(portalDirectoryActions)[0], 'set')).toEqual({ status: 'applied', appliedAt: NOW });
  });

  it('a passing source re-check applies the action', async () => {
    const verifySource = vi.fn(async () => null);
    scriptDisable({});
    const out = await disablePortalIdentity({ ...directoryInput, expect: { directoryChain: CHAIN, verifySource } });
    expect(out.kind).toBe('disabled');
    expect(verifySource).toHaveBeenCalledTimes(1);
  });

  it('a google blocker locks the google source', async () => {
    scriptDisable({});
    await disablePortalIdentity({ ...directoryInput, blocker: 'google_directory', reason: 'suspended' });
    expect(sqlText(h.calls[0]!).params).toEqual([`portal-directory:${ORG}:google`]);
  });

  it('password account under allowed: identity disabled, account active, epoch bumped, keepsPassword true', async () => { // RF3
    scriptDisable({ account: { authMethod: 'password', passwordHash: 'argon2-hash' } });
    const out = await disablePortalIdentity(directoryInput);

    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: false, keepsPassword: true });
    expect(policy.calls).toBe(1);
    const accSet = firstArg(updatesOf(portalUsers)[0], 'set');
    expect(accSet).toHaveProperty('authEpoch');
    expect(accSet).not.toHaveProperty('status');
    expect(accSet).not.toHaveProperty('disabledBy');
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU]);
    expect(purgeClientAiSessionsForUsers).toHaveBeenCalledWith(fakeRedis, [PU]);
  });

  it('password account under sso_only: account disabled', async () => { // RF3
    policy.mode = 'sso_only';
    scriptDisable({ account: { authMethod: 'password', passwordHash: 'argon2-hash' } });
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: true, keepsPassword: false });
    expect(firstArg(updatesOf(portalUsers)[0], 'set')).toMatchObject({ status: 'disabled', disabledBy: 'directory' });
  });

  it('a second enabled identity keeps the account active', async () => { // RF3
    scriptDisable({ otherUsable: 1 });
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: false, keepsPassword: false });
    const accSet = firstArg(updatesOf(portalUsers)[0], 'set');
    expect(accSet).toHaveProperty('authEpoch');
    expect(accSet).not.toHaveProperty('status');
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU]);
  });

  it('an already-disabled account: identity disabled, account untouched, disabled_by unchanged', async () => { // RF4
    scriptDisable({ account: { status: 'disabled', disabledBy: 'msp' } });
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: false, keepsPassword: false });
    const accSet = firstArg(updatesOf(portalUsers)[0], 'set');
    expect(accSet).not.toHaveProperty('status');
    expect(accSet).not.toHaveProperty('disabledBy');
    expect(accSet).toHaveProperty('authEpoch'); // every identity disable bumps the epoch (D2)
  });

  it('an add-in-only account (browser_access none) is disabled and its add-in sessions purged', async () => { // RF3
    scriptDisable({ account: { browserAccess: 'none' } });
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'disabled', portalUserId: PU, accountDisabled: true, keepsPassword: false });
    expect(firstArg(updatesOf(portalUsers)[0], 'set')).toMatchObject({ status: 'disabled', browserAccess: 'none', disabledBy: 'directory' });
    expect(purgeClientAiSessionsForUsers).toHaveBeenCalledWith(fakeRedis, [PU]);
  });

  it('a second blocker is added, not a no-op: blocker_added, first reason kept, no second epoch bump', async () => { // RF4, quorum D9
    const firstAt = new Date('2027-01-30T00:00:00.000Z');
    scriptDisable({
      withAction: false,
      account: { status: 'disabled', disabledBy: 'directory' },
      identity: { disabledAt: firstAt, disabledReason: 'account_disabled', disabledBlockers: ['entra_directory'] },
    });
    const out = await disablePortalIdentity({ orgId: ORG, identityId: IDENT, blocker: 'scim', reason: 'scim_deactivated', now: NOW });

    expect(out).toEqual({ kind: 'blocker_added', portalUserId: PU, accountDisabled: false });
    expect(firstArg(updatesOf(portalUserIdentities)[0], 'set')).toEqual({
      disabledBlockers: ['entra_directory', 'scim'], disabledAt: firstAt, disabledReason: 'account_disabled',
    });
    expect(updatesOf(portalUsers)).toEqual([]);
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
    // W9 passes no run: no advisory lock, no action, audit runId null.
    expect(h.calls.some((c) => c.op === 'execute')).toBe(false);
    expect(firstArg(inserts()[0], 'values').details).toMatchObject({ blocker: 'scim', runId: null });
  });

  it('a second blocker re-runs the account rule: an account kept by a password that no longer signs in is disabled', async () => {
    policy.mode = 'sso_only';
    scriptDisable({
      account: { authMethod: 'password', passwordHash: 'argon2-hash' },
      identity: { disabledAt: new Date('2027-01-30T00:00:00.000Z'), disabledReason: 'msp', disabledBlockers: ['msp'] },
    });
    const out = await disablePortalIdentity(directoryInput);
    expect(out).toEqual({ kind: 'blocker_added', portalUserId: PU, accountDisabled: true });
    const accSet = firstArg(updatesOf(portalUsers)[0], 'set');
    expect(accSet).toMatchObject({ status: 'disabled', disabledBy: 'directory' });
    // A real transition into disabled still ends sessions.
    expect(accSet).toHaveProperty('authEpoch');
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU]);
  });

  describe('skips write nothing', () => {
    it('not found: no identity in the org', async () => {
      h.results.push([], []);
      expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'not_found' });
      expect(writes()).toEqual([]);
    });

    it('not found: a malformed id never reaches SQL', async () => {
      expect(await disablePortalIdentity({ ...directoryInput, identityId: 'nope' })).toEqual({ kind: 'skipped', reason: 'not_found' });
      expect(h.calls).toEqual([]);
    });

    it('not found: the identity locked is not the one read (another org or account)', async () => {
      h.results.push([], [owner()], [account()], [identity({ orgId: '00000000-0000-4000-8000-000000000000' })]);
      expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'not_found' });
      expect(writes()).toEqual([]);
    });

    it('already blocked by the same source', async () => {
      h.results.push([], [owner()], [account()], [identity({
        disabledAt: NOW, disabledReason: 'absent', disabledBlockers: ['entra_directory'],
      })]);
      expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'already_blocked' });
      expect(writes()).toEqual([]);
    });

    it('chain changed since evaluation', async () => {
      h.results.push([], [owner()], [account()], [identity({ directoryChain: 'entra:other' })]);
      expect(await disablePortalIdentity({ ...directoryInput, expect: { directoryChain: CHAIN } }))
        .toEqual({ kind: 'skipped', reason: 'chain_changed' });
      expect(writes()).toEqual([]);
    });

    it('rearmed by a Restore (directory blockers only)', async () => {
      h.results.push([], [owner()], [account()], [identity({ directoryRearmSince: NOW })]);
      expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'rearmed' });
      expect(writes()).toEqual([]);
      expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
    });

    it.each(['skipped', 'superseded', 'applied', 'reported', 'restored'])(
      'the action is no longer awaiting application (%s meanwhile)',
      async (status) => {
        h.results.push([], [owner()], [account()], [identity()], [heldAction({ status })]);
        expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'action_not_pending' });
        expect(writes()).toEqual([]);
      },
    );

    it('observation changed: a newer run evaluated the identity since the action was planned', async () => { // D8d
      h.results.push([], [owner()], [account()], [identity({ directoryLastRunId: '00000000-0000-4000-8000-0000000000aa' })], [heldAction()]);
      expect(await disablePortalIdentity(directoryInput)).toEqual({ kind: 'skipped', reason: 'observation_changed' });
      expect(writes()).toEqual([]);
    });

    it.each(['connection_changed', 'tenant_not_proven', 'org_inactive'] as const)(
      'the source re-check fails (%s): a skip that writes nothing, run under the D3 locks',
      async (failure) => { // D8d
        const verifySource = vi.fn(async () => {
          // Under the account and identity locks, inside the action's transaction.
          expect(h.txDepth.current).toBe(1);
          expect(h.calls.filter((c) => c.op === 'select' && stepsOf(c, 'for').length > 0)).toHaveLength(3);
          return failure;
        });
        h.results.push([], [owner()], [account()], [identity()], [heldAction()]);
        expect(await disablePortalIdentity({ ...directoryInput, expect: { directoryChain: CHAIN, verifySource } }))
          .toEqual({ kind: 'skipped', reason: failure });
        expect(verifySource).toHaveBeenCalledTimes(1);
        expect(writes()).toEqual([]);
      },
    );
  });

  it('a purge failure leaves sessions_purged_at null and does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(purgePortalSessionsForUsers).mockRejectedValueOnce(new Error('redis down'));
    scriptDisable({});
    const out = await disablePortalIdentity(directoryInput);
    expect(out.kind).toBe('disabled');
    const actionUpdates = updatesOf(portalDirectoryActions);
    expect(actionUpdates).toHaveLength(1); // applied, never purged
    expect(errors).toHaveBeenCalled();
    expect(JSON.stringify(errors.mock.calls)).not.toMatch(/@/);
    errors.mockRestore();
  });

  it('refuses to run inside a held DB context', async () => {
    h.held.current = true;
    await expect(disablePortalIdentity(directoryInput)).rejects.toThrow(/runOutsideDbContext/);
    expect(h.calls).toEqual([]);
  });

  it('a run action needs a directory blocker', async () => {
    await expect(disablePortalIdentity({ ...directoryInput, blocker: 'scim', reason: 'scim_deactivated' })).rejects.toThrow(/directory blocker/);
  });
});

describe('retryPendingPurges', () => {
  it('purges applied actions with no sessions_purged_at and stamps each one', async () => {
    h.results.push([{ id: ACTION, portalUserId: PU }]);
    const finished = await retryPendingPurges(NOW);
    expect(finished).toBe(1);
    expect(purgePortalSessionsForUsers).toHaveBeenCalledWith([PU]);
    expect(purgeClientAiSessionsForUsers).toHaveBeenCalledWith(fakeRedis, [PU]);
    const [stamp] = updatesOf(portalDirectoryActions);
    expect(firstArg(stamp, 'set')).toEqual({ sessionsPurgedAt: NOW });
  });

  it('logs how many applied actions aged out of the 24 h window unpurged (a count only)', async () => { // review fix
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.results.push([], [{ agedOut: 3 }]);
    expect(await retryPendingPurges(NOW)).toBe(0);
    const countQuery = h.calls.filter((c) => c.op === 'select').at(1);
    const where = new PgDialect().sqlToQuery(stepsOf(countQuery, 'where')[0]![0] as SQL);
    expect(where.sql).toMatch(/"sessions_purged_at" is null/i);
    expect(where.sql).toMatch(/"applied_at" </);
    expect(where.params).toEqual(expect.arrayContaining(['applied', new Date(NOW.getTime() - 24 * 3600_000).toISOString()]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).toMatch(/aged out/);
    expect(warn.mock.calls[0]![1]).toEqual({ agedOut: 3 });
    // None aged out: no line.
    warn.mockClear();
    h.results.push([], [{ agedOut: 0 }]);
    await retryPendingPurges(NOW);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('leaves a still-failing purge for the next sweep', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(purgeClientAiSessionsForUsers).mockRejectedValueOnce(new Error('redis down'));
    h.results.push([{ id: ACTION, portalUserId: PU }]);
    expect(await retryPendingPurges(NOW)).toBe(0);
    expect(updatesOf(portalDirectoryActions)).toEqual([]);
    errors.mockRestore();
  });

  it('a purge failure on the first try is finished by the retry', async () => { // plan Task 3 test
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(purgePortalSessionsForUsers).mockRejectedValueOnce(new Error('redis down'));
    scriptDisable({});
    await disablePortalIdentity(directoryInput);
    expect(updatesOf(portalDirectoryActions)).toHaveLength(1);
    h.calls.length = 0;
    h.results.push([{ id: ACTION, portalUserId: PU }]);
    expect(await retryPendingPurges(NOW)).toBe(1);
    expect(firstArg(updatesOf(portalDirectoryActions)[0], 'set')).toEqual({ sessionsPurgedAt: NOW });
    errors.mockRestore();
  });
});

describe('restorePortalIdentity (D9)', () => {
  const restoreInput = {
    orgId: ORG, portalUserId: PU, identityId: IDENT, reactivateAccount: true, confirmMspDisabled: false, actorUserId: ACTOR, now: NOW,
  };
  const disabledIdentity = { disabledAt: NOW, disabledReason: 'absent', disabledBlockers: ['entra_directory', 'scim'] };

  it('clears every blocker, sets rearm, marks the latest applied action restored, and reactivates with msp_reactivate', async () => { // RF4
    h.results.push(
      [owner()], [], [account({ status: 'disabled', disabledBy: 'directory' })], [identity(disabledIdentity)],
      [], [{ id: ACTION }], [], [], [],
    );
    const out = await restorePortalIdentity(restoreInput);

    expect(out).toEqual({ accountStatus: 'active', blockersCleared: ['entra_directory', 'scim'] });
    expect(sqlText(h.calls[1]!).params).toEqual([`portal-directory:${ORG}:entra`]);
    expect(stepsOf(h.calls[2], 'for')[0]).toEqual(['update']);
    expect(stepsOf(h.calls[3], 'for')[0]).toEqual(['update']);
    expect(firstArg(updatesOf(portalUserIdentities)[0], 'set')).toEqual({
      disabledAt: null, disabledReason: null, disabledBlockers: [],
      directoryRearmSince: NOW, directoryAbsentRuns: 0, directoryAbsentSince: null,
    });
    expect(firstArg(updatesOf(portalDirectoryActions)[0], 'set')).toEqual({ status: 'restored', restoredAt: NOW, restoredByUserId: ACTOR });
    const accSet = firstArg(updatesOf(portalUsers)[0], 'set');
    expect(accSet).toMatchObject({ status: 'active', disabledBy: null });
    expect(accSet).toHaveProperty('authEpoch');
    const audits = inserts().map((c) => firstArg(c, 'values'));
    expect(audits.map((a) => a.action)).toEqual(['organization.portal_user.update', 'organization.portal_user.identity.restore']);
    expect(audits[1]).toMatchObject({
      actorType: 'user', actorId: ACTOR, resourceType: 'portal_user', resourceId: PU,
      details: { identityId: IDENT, blockersCleared: ['entra_directory', 'scim'], reactivated: true },
    });
    expect(inserts().every((c) => c.depth === 1)).toBe(true);
    expect(markRequestAuditWritten).toHaveBeenCalled();
    expect(purgePortalSessionsForUsers).not.toHaveBeenCalled();
  });

  it('without reactivateAccount the account stays disabled', async () => {
    h.results.push([owner()], [], [account({ status: 'disabled', disabledBy: 'directory' })], [identity(disabledIdentity)], [], [], []);
    const out = await restorePortalIdentity({ ...restoreInput, reactivateAccount: false });
    expect(out).toEqual({ accountStatus: 'disabled', blockersCleared: ['entra_directory', 'scim'] });
    expect(updatesOf(portalUsers)).toEqual([]);
    expect(inserts().map((c) => firstArg(c, 'values').action)).toEqual(['organization.portal_user.identity.restore']);
  });

  it('restore of an msp-disabled account without confirmMspDisabled is PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM', async () => {
    h.results.push([owner()], [], [account({ status: 'disabled', disabledBy: 'msp' })], [identity(disabledIdentity)]);
    const err = await rejection(restorePortalIdentity(restoreInput));
    expect(err).toBeInstanceOf(PortalDirectoryIdentityError);
    expect(err).toMatchObject({ code: 'PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM', httpStatus: 409 });
    expect(writes()).toEqual([]);
  });

  it('an msp-disabled account is reactivated with both confirmations', async () => {
    h.results.push([owner()], [], [account({ status: 'disabled', disabledBy: 'msp' })], [identity(disabledIdentity)], [], [], [], [], []);
    const out = await restorePortalIdentity({ ...restoreInput, confirmMspDisabled: true });
    expect(out.accountStatus).toBe('active');
  });

  it('a password-only fallback under sso_only does not count, but the restored identity does', async () => {
    policy.mode = 'sso_only';
    h.results.push(
      [owner()], [], [account({ status: 'disabled', disabledBy: 'directory', authMethod: 'password', passwordHash: 'argon2-hash' })],
      [identity(disabledIdentity)], [], [], [], [], [],
    );
    const out = await restorePortalIdentity(restoreInput);
    expect(out.accountStatus).toBe('active');
  });

  it('restore of an enabled identity is PORTAL_IDENTITY_NOT_DISABLED', async () => {
    h.results.push([owner()], [], [account()], [identity()]);
    const err = await rejection(restorePortalIdentity(restoreInput));
    expect(err).toMatchObject({ code: 'PORTAL_IDENTITY_NOT_DISABLED', httpStatus: 409 });
    expect(writes()).toEqual([]);
  });

  it('a missing identity, or one of another account, is PORTAL_IDENTITY_NOT_FOUND', async () => {
    h.results.push([]);
    expect(await rejection(restorePortalIdentity(restoreInput))).toMatchObject({ code: 'PORTAL_IDENTITY_NOT_FOUND', httpStatus: 404 });
    expect(await rejection(restorePortalIdentity({ ...restoreInput, identityId: 'bad' })))
      .toMatchObject({ code: 'PORTAL_IDENTITY_NOT_FOUND', httpStatus: 404 });
    expect(writes()).toEqual([]);
  });

  it('refuses to run inside a held DB context', async () => {
    h.held.current = true;
    await expect(restorePortalIdentity(restoreInput)).rejects.toThrow(/runOutsideDbContext/);
  });
});

describe('removeDisabledPortalIdentity (OD3)', () => {
  const removeInput = { orgId: ORG, portalUserId: PU, identityId: IDENT, actorUserId: ACTOR };

  it('deletes one identity disabled by a directory blocker, clears the legacy Entra columns and audits', async () => {
    h.results.push(
      [owner()], [], [account({ status: 'disabled', disabledBy: 'directory' })],
      [identity({ disabledAt: NOW, disabledReason: 'absent', disabledBlockers: ['entra_directory'] })],
      [], [], [],
    );
    const out = await removeDisabledPortalIdentity(removeInput);
    expect(out).toEqual({ identityId: IDENT, provider: 'entra', blockers: ['entra_directory'] });
    const del = h.calls.filter((c) => c.op === 'delete');
    expect(del).toHaveLength(1);
    expect(del[0]!.args[0]).toBe(portalUserIdentities);
    expect(firstArg(updatesOf(portalUsers)[0], 'set')).toMatchObject({ entraTenantId: null, entraOid: null });
    expect(firstArg(inserts()[0], 'values')).toMatchObject({
      action: 'organization.portal_user.identity.remove',
      actorType: 'user', actorId: ACTOR, resourceType: 'portal_user', resourceId: PU,
      details: { identityId: IDENT, provider: 'entra', blockers: ['entra_directory'] },
    });
    expect(markRequestAuditWritten).toHaveBeenCalled();
  });

  it('a google identity has no legacy columns to clear', async () => {
    h.results.push(
      [owner({ provider: 'google', entraTenantId: null })], [], [account()],
      [identity({ provider: 'google', entraTenantId: null, disabledAt: NOW, disabledReason: 'suspended', disabledBlockers: ['google_directory'] })],
      [], [],
    );
    await removeDisabledPortalIdentity(removeInput);
    expect(sqlText(h.calls[1]!).params).toEqual([`portal-directory:${ORG}:google`]);
    expect(updatesOf(portalUsers)).toEqual([]);
  });

  it('refuses an enabled identity or one disabled only by scim / msp', async () => {
    for (const ident of [identity(), identity({ disabledAt: NOW, disabledReason: 'scim_deactivated', disabledBlockers: ['scim'] })]) {
      h.results.push([owner()], [], [account()], [ident]);
      const err = await rejection(removeDisabledPortalIdentity(removeInput));
      expect(err).toMatchObject({ code: 'PORTAL_IDENTITY_NOT_DIRECTORY_DISABLED', httpStatus: 409 });
    }
    expect(writes()).toEqual([]);
  });

  it('a missing identity is PORTAL_IDENTITY_NOT_FOUND', async () => {
    h.results.push([]);
    expect(await rejection(removeDisabledPortalIdentity(removeInput))).toMatchObject({ code: 'PORTAL_IDENTITY_NOT_FOUND', httpStatus: 404 });
  });
});
