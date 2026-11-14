/**
 * Unit tests for the directory run store (portal registration W8 #11385, plan
 * Task 5; D6, D7, D8, D12) over a scripted Drizzle mock: report vs enforce,
 * holds, supersede, dedupe, the impact digest, after-commit effects and
 * retention. Real-Postgres behaviour (the observation UPDATE, ON CONFLICT,
 * cascades, the full apply) is proven in
 * __tests__/integration/portalDirectoryRunStore.integration.test.ts.
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
  return { calls, results, txDepth, builder };
});

vi.mock('../../db', () => ({
  db: {
    select: (...a: unknown[]) => h.builder('select', a),
    insert: (...a: unknown[]) => h.builder('insert', a),
    update: (...a: unknown[]) => h.builder('update', a),
    delete: (...a: unknown[]) => h.builder('delete', a),
    execute: (...a: unknown[]) => h.builder('execute', a),
  },
  hasDbAccessContext: vi.fn(() => h.txDepth.current > 0),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    h.txDepth.current += 1;
    try { return await fn(); } finally { h.txDepth.current -= 1; }
  }),
  runOutsideDbContext: vi.fn(<T,>(fn: () => T) => fn()),
}));

const mode = vi.hoisted(() => ({ enforce: false }));
vi.mock('./mode', () => ({
  isDirectoryDeprovisionEnforced: vi.fn(() => mode.enforce),
  directoryMode: vi.fn((forceReport = false) => (!forceReport && mode.enforce ? 'enforce' : 'report')),
}));
const policy = vi.hoisted(() => ({ mode: 'allowed' as 'allowed' | 'sso_only' }));
vi.mock('../portalAccessPolicy', () => ({
  resolvePortalAccessPolicy: vi.fn(async () => ({ effective: { passwordMode: { value: policy.mode } } })),
}));
vi.mock('./queue', () => ({ enqueueApplyRun: vi.fn(async () => true) }));
vi.mock('./notify', () => ({ notifyDirectoryRunHeld: vi.fn(async () => undefined) }));
vi.mock('../sentry', () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock('./identityDisable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./identityDisable')>()),
  disablePortalIdentity: vi.fn(),
}));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn(async (orgId: string) => ({ orgId, partnerId: 'p' })) }));
vi.mock('../auditRequestTracking', () => ({ markRequestAuditWritten: vi.fn() }));

import { db } from '../../db';
import { auditLogs, portalDirectoryActions, portalDirectoryRuns, portalUserIdentities } from '../../db/schema';
import { captureMessage } from '../sentry';
import { getActiveOrgTenant } from '../tenantStatus';
import { entraChainKey, googleChainKey } from './chain';
import type { DirectoryObservation, InScopeIdentity } from './evaluate';
import { disablePortalIdentity, PortalDirectoryIdentityError } from './identityDisable';
import { notifyDirectoryRunHeld } from './notify';
import { enqueueApplyRun } from './queue';
import {
  afterRunCommitted,
  applyRun,
  decideHeldRunApply,
  dismissHeldRun,
  impactDigestOf,
  pruneDirectoryRuns,
  recordEvaluatedRun,
  recordRefusedRun,
  verifyDirectorySource,
} from './runStore';

const ORG = '0b9d6a52-8f43-4c5e-9a1d-2f6c7b8e9d01';
const OTHER_ORG = '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a';
const RUN = '9f8e7d6c-5b4a-4398-8776-655443322110';
const PREV_RUN = '8e7d6c5b-4a39-4887-9665-544332211009';
const ACTOR = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const CONN = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f';
const TID = '11111111-2222-4333-8444-555555555555';
const CHAIN = entraChainKey({ tenantId: TID, connectionId: CONN, consentGeneration: 1, orgId: ORG });
const NOW = new Date('2027-02-01T12:00:00.000Z');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const userOf = (n: number) => uuid(1000 + n);

function ident(n: number, over: Partial<InScopeIdentity> = {}): InScopeIdentity {
  return {
    identityId: uuid(n), portalUserId: userOf(n), provider: 'entra', subject: `oid-${n}`,
    directoryChain: CHAIN, directorySeenAt: new Date('2027-01-01T00:00:00.000Z'), directoryAbsentRuns: 0,
    directoryAbsentSince: null, directoryLastRunId: PREV_RUN, directoryRearmSince: null, ...over,
  };
}

function stepsOf(call: Call | undefined, name: string): unknown[][] {
  return (call?.steps ?? []).filter(([n]) => n === name).map(([, a]) => a);
}
function firstArg(call: Call | undefined, name: string): Record<string, unknown> {
  return stepsOf(call, name)[0]?.[0] as Record<string, unknown>;
}
const updatesOf = (table: unknown) => h.calls.filter((c) => c.op === 'update' && c.args[0] === table);
const insertsOf = (table: unknown) => h.calls.filter((c) => c.op === 'insert' && c.args[0] === table);
const writes = () => h.calls.filter((c) => c.op === 'insert' || c.op === 'update' || c.op === 'delete' || c.op === 'execute');
const sqlOf = (call: Call) => new PgDialect().sqlToQuery(call.args[0] as SQL);
const whereSql = (call: Call | undefined) => new PgDialect().sqlToQuery(stepsOf(call, 'where')[0]![0] as SQL);

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e);
}

interface RecordScript {
  dup?: Record<string, unknown>;
  prevEvaluatedCount?: number | null;
  latest?: { outcome: 'evaluated' | 'suspect_shrink'; directoryUserCount: number } | null;
  chainApplied?: boolean;
  /** updates written (one execute per 1000) */
  updates?: number;
  accounts?: Array<Record<string, unknown>>;
  usable?: Array<{ portalUserId: string; id: string }>;
}

/** Scripts recordEvaluatedRun's statements in order. */
function scriptRecord(s: RecordScript) {
  if (s.dup) {
    h.results.push([], [s.dup]);
    return;
  }
  h.results.push([{ id: RUN }]);                                                     // insert run
  h.results.push(s.prevEvaluatedCount == null ? [] : [{ directoryUserCount: s.prevEvaluatedCount }]);
  h.results.push(s.latest ? [s.latest] : []);                                         // latest evaluated|suspect
  h.results.push(s.chainApplied ? [{ id: PREV_RUN }] : []);                           // chain applied before
  for (let i = 0; i < Math.ceil((s.updates ?? 0) / 1000); i += 1) h.results.push([]); // observation updates
  h.results.push([], []);                                                             // supersede actions, runs
  if (s.accounts) h.results.push(s.accounts, s.usable ?? []);
}

const account = (n: number, over: Record<string, unknown> = {}) =>
  ({ id: userOf(n), status: 'active', authMethod: 'entra', passwordHash: null, ...over });

function observeFrom(map: Record<string, DirectoryObservation>): (subject: string) => DirectoryObservation {
  return (subject) => map[subject] ?? { present: true, state: 'enabled' };
}

const recordInput = (identities: InScopeIdentity[], observe: (s: string) => DirectoryObservation, over: Record<string, unknown> = {}) => ({
  orgId: ORG, source: 'entra' as const, snapshotKey: `${CONN}:1:7`, snapshotAt: NOW, chainKey: CHAIN,
  directoryUserCount: 100, identities, observe, ...over,
});

beforeEach(() => {
  h.calls.length = 0;
  h.results.length = 0;
  h.txDepth.current = 0;
  mode.enforce = false;
  policy.mode = 'allowed';
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

describe('impactDigestOf', () => {
  const a = { id: uuid(1), identityId: uuid(11), effect: 'identity', keepsPassword: false };
  const b = { id: uuid(2), identityId: uuid(12), effect: 'identity_and_account', keepsPassword: true };

  it('is a sha256 over the sorted (actionId, identityId, effect, keepsPassword) tuples', () => {
    const d = impactDigestOf([a, b]);
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(impactDigestOf([b, a])).toBe(d);
    for (const changed of [{ ...b, id: uuid(3) }, { ...b, identityId: uuid(13) }, { ...b, effect: 'identity' }, { ...b, keepsPassword: false }]) {
      expect(impactDigestOf([a, changed])).not.toBe(d);
    }
  });
});

describe('recordRefusedRun', () => {
  it('records the refusal once (ON CONFLICT DO NOTHING) with the mode in force and no chain', async () => {
    mode.enforce = true;
    await recordRefusedRun(db, { orgId: ORG, source: 'entra', snapshotKey: 'k', snapshotAt: NOW, outcome: 'incomplete', reason: 'sync_incomplete' });
    const [ins] = insertsOf(portalDirectoryRuns);
    expect(firstArg(ins, 'values')).toMatchObject({
      orgId: ORG, source: 'entra', snapshotKey: 'k', outcome: 'incomplete', reason: 'sync_incomplete',
      mode: 'enforce', disposition: 'none', chainKey: null,
    });
    expect(stepsOf(ins, 'onConflictDoNothing')).toHaveLength(1);
    expect(writes()).toHaveLength(1);
  });
});

describe('recordEvaluatedRun', () => {
  it('report mode records reported actions and disables nothing', async () => { // inv. 12
    const ids = [ident(1), ident(2), ident(3)];
    scriptRecord({ updates: 3, accounts: [account(1)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput(ids, observeFrom({ 'oid-1': { present: true, state: 'disabled', reason: 'account_disabled' } })));

    expect(out).toMatchObject({ runId: RUN, disposition: 'reported', holdReason: null, created: true, affected: 1, usable: 3 });
    const [actions] = insertsOf(portalDirectoryActions);
    expect(firstArg(actions, 'values')).toEqual([expect.objectContaining({
      orgId: ORG, runId: RUN, identityId: uuid(1), portalUserId: userOf(1), provider: 'entra', reason: 'account_disabled',
      effect: 'identity_and_account', keepsPassword: false, status: 'reported', skipReason: null,
    })]);
    const runUpdate = updatesOf(portalDirectoryRuns).at(-1);
    expect(firstArg(runUpdate, 'set')).toMatchObject({
      outcome: 'evaluated', disposition: 'reported', holdReason: null, affectedCount: 1, usableCount: 3, directoryUserCount: 100,
    });
    expect(firstArg(runUpdate, 'set').impactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(insertsOf(auditLogs)).toEqual([]);
    expect(disablePortalIdentity).not.toHaveBeenCalled();
    // Observations are still written in report mode (D7).
    const exec = h.calls.filter((c) => c.op === 'execute');
    expect(exec).toHaveLength(1);
    expect(sqlOf(exec[0]!).sql).toMatch(/update "portal_user_identities"/i);
    expect(sqlOf(exec[0]!).params).toContain(RUN);

    await afterRunCommitted(out);
    expect(enqueueApplyRun).not.toHaveBeenCalled();
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled();
  });

  it('forceReport keeps report even when enforced; nothing can force enforce', async () => {
    mode.enforce = true;
    scriptRecord({ updates: 2, accounts: [account(1), account(2)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput([ident(1), ident(2)], () => ({ present: true, state: 'disabled', reason: 'account_disabled' }), { forceReport: true }));
    expect(out.disposition).toBe('reported');
    expect(firstArg(insertsOf(portalDirectoryRuns)[0], 'values')).toMatchObject({ mode: 'report' });
    // The input type has no "force enforce": with the env off, a run is report.
    mode.enforce = false;
    h.calls.length = 0;
    scriptRecord({ updates: 1 });
    await recordEvaluatedRun(db, recordInput([ident(1)], observeFrom({}), { forceReport: false }));
    expect(firstArg(insertsOf(portalDirectoryRuns)[0], 'values')).toMatchObject({ mode: 'report' });
  });

  it('a duplicate snapshot key is a no-op that returns the existing run, and its after-commit does nothing', async () => {
    mode.enforce = true;
    scriptRecord({ dup: { id: PREV_RUN, disposition: 'held', holdReason: 'threshold', affectedCount: 4, usableCount: 9 } });
    const out = await recordEvaluatedRun(db, recordInput([ident(1)], observeFrom({})));
    expect(out).toEqual({
      runId: PREV_RUN, orgId: ORG, source: 'entra', disposition: 'held', holdReason: 'threshold', affected: 4, usable: 9, created: false,
    });
    expect(writes()).toHaveLength(1); // the refused insert only
    await afterRunCommitted(out);
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('enforce: over the threshold holds every action; the held audit is in the run transaction, the email after commit, once', async () => {
    mode.enforce = true;
    scriptRecord({ updates: 2, chainApplied: true, accounts: [account(1), account(2)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput([ident(1), ident(2)], () => ({ present: true, state: 'disabled', reason: 'account_disabled' })));

    expect(out).toMatchObject({ disposition: 'held', holdReason: 'threshold', affected: 2, usable: 2, created: true });
    const values = firstArg(insertsOf(portalDirectoryActions)[0], 'values') as unknown as Array<Record<string, unknown>>;
    expect(values.map((v) => v.status)).toEqual(['held', 'held']);
    const [audit] = insertsOf(auditLogs);
    expect(firstArg(audit, 'values')).toMatchObject({
      orgId: ORG, actorType: 'system', action: 'portal.directory.run.held', resourceType: 'portal_directory_run', resourceId: RUN,
      details: { source: 'entra', affected: 2, usable: 2, holdReason: 'threshold' },
    });
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled(); // nothing leaves the transaction

    await afterRunCommitted(out);
    expect(notifyDirectoryRunHeld).toHaveBeenCalledTimes(1);
    expect(notifyDirectoryRunHeld).toHaveBeenCalledWith({ orgId: ORG, runId: RUN, source: 'entra', affected: 2 });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureMessage).mock.calls[0]![1]).toMatchObject({ eventCode: 'portal_directory_held', fingerprint: ['portal_directory_held'] });
    expect(String(vi.mocked(captureMessage).mock.calls[0]![0])).not.toMatch(/oid-|@/);
    expect(enqueueApplyRun).not.toHaveBeenCalled();
  });

  it('the hold denominator counts only members of this chain: identities never seen in the directory do not dilute it', async () => { // review fix
    mode.enforce = true;
    // 2 members (seen before, now disabled) + 8 in-scope identities this
    // directory never listed (e.g. another Google workspace's people).
    const members = [ident(1), ident(2)];
    const strangers = Array.from({ length: 8 }, (_, i) => ident(i + 3, { directorySeenAt: null }));
    const listed: Record<string, DirectoryObservation> = {
      'oid-1': { present: true, state: 'disabled', reason: 'suspended' },
      'oid-2': { present: true, state: 'disabled', reason: 'suspended' },
    };
    scriptRecord({ updates: 10, chainApplied: true, accounts: [account(1), account(2)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput([...members, ...strangers], (s) => listed[s] ?? { present: false }));
    // 2 of 2 members affected ⇒ the ≥2 && ≥50 % threshold holds (2 of 10 would not).
    expect(out).toMatchObject({ disposition: 'held', holdReason: 'threshold', affected: 2, usable: 2 });
    expect(firstArg(updatesOf(portalDirectoryRuns).at(-1), 'set')).toMatchObject({ usableCount: 2, affectedCount: 2 });
  });

  it('enforce: the first run with actions in a chain is held even under the threshold', async () => { // D8c
    mode.enforce = true;
    const ids = Array.from({ length: 40 }, (_, i) => ident(i + 1));
    scriptRecord({ updates: 40, chainApplied: false, accounts: [account(1)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput(ids, observeFrom({ 'oid-1': { present: true, state: 'disabled', reason: 'account_disabled' } })));
    expect(out).toMatchObject({ disposition: 'held', holdReason: 'first_enforcement', affected: 1, usable: 40 });
  });

  it('enforce: a later run under the threshold is applying with pending actions, and its after-commit enqueues apply-run', async () => {
    mode.enforce = true;
    const ids = Array.from({ length: 40 }, (_, i) => ident(i + 1));
    scriptRecord({ updates: 40, chainApplied: true, accounts: [account(1)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput(ids, observeFrom({ 'oid-1': { present: true, state: 'disabled', reason: 'account_disabled' } })));
    expect(out).toMatchObject({ disposition: 'applying', holdReason: null });
    const values = firstArg(insertsOf(portalDirectoryActions)[0], 'values') as unknown as Array<Record<string, unknown>>;
    expect(values.map((v) => v.status)).toEqual(['pending']);
    expect(insertsOf(auditLogs)).toEqual([]);
    await afterRunCommitted(out);
    expect(enqueueApplyRun).toHaveBeenCalledWith(RUN, ORG);
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled();
  });

  it('a run with no actions is disposition none, even in enforce mode', async () => {
    mode.enforce = true;
    scriptRecord({ updates: 2 });
    const out = await recordEvaluatedRun(db, recordInput([ident(1), ident(2)], observeFrom({})));
    expect(out).toMatchObject({ disposition: 'none', affected: 0 });
    expect(insertsOf(portalDirectoryActions)).toEqual([]);
    expect(firstArg(updatesOf(portalDirectoryRuns).at(-1), 'set')).toMatchObject({ impactDigest: null, disposition: 'none' });
  });

  it('effects: a usable password keeps the account (keepsPassword), a second usable identity keeps it, two identities of one account both planned do not keep each other', async () => {
    const ids = [ident(1), ident(2), ident(3), ident(4, { portalUserId: userOf(3) })];
    scriptRecord({
      updates: 4,
      accounts: [account(1, { authMethod: 'password', passwordHash: 'h' }), account(2), account(3)],
      usable: [
        { portalUserId: userOf(1), id: uuid(1) },
        { portalUserId: userOf(2), id: uuid(2) }, { portalUserId: userOf(2), id: uuid(99) },
        { portalUserId: userOf(3), id: uuid(3) }, { portalUserId: userOf(3), id: uuid(4) },
      ],
    });
    await recordEvaluatedRun(db, recordInput(ids, () => ({ present: true, state: 'disabled', reason: 'account_disabled' })));
    const values = firstArg(insertsOf(portalDirectoryActions)[0], 'values') as unknown as Array<Record<string, unknown>>;
    const byIdentity = Object.fromEntries(values.map((v) => [v.identityId, [v.effect, v.keepsPassword]]));
    expect(byIdentity).toEqual({
      [uuid(1)]: ['identity', true],
      [uuid(2)]: ['identity', false],
      [uuid(3)]: ['identity_and_account', false],
      [uuid(4)]: ['identity_and_account', false],
    });
  });

  it('a rearmed identity is listed as skipped (rearmed), never counted, held or applied', async () => {
    mode.enforce = true;
    scriptRecord({ updates: 1, chainApplied: true, accounts: [account(1)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput(
      [ident(1, { directoryRearmSince: new Date('2027-01-31T00:00:00.000Z') })],
      () => ({ present: true, state: 'disabled', reason: 'account_disabled' }),
    ));
    expect(out).toMatchObject({ disposition: 'none', affected: 0 });
    const values = firstArg(insertsOf(portalDirectoryActions)[0], 'values') as unknown as Array<Record<string, unknown>>;
    expect(values).toEqual([expect.objectContaining({ status: 'skipped', skipReason: 'rearmed' })]);
    expect(firstArg(updatesOf(portalDirectoryRuns).at(-1), 'set')).toMatchObject({ impactDigest: null });
  });

  it('a newer evaluated run supersedes the previous held or pending actions of its chain', async () => {
    scriptRecord({ updates: 1 });
    await recordEvaluatedRun(db, recordInput([ident(1)], observeFrom({})));
    const [actionsUpdate] = updatesOf(portalDirectoryActions);
    expect(firstArg(actionsUpdate, 'set')).toEqual({ status: 'superseded' });
    const actionsWhere = whereSql(actionsUpdate);
    expect(actionsWhere.params).toEqual(expect.arrayContaining([ORG, 'held', 'pending', 'entra', CHAIN, RUN]));
    const runsUpdate = updatesOf(portalDirectoryRuns)[0];
    expect(firstArg(runsUpdate, 'set')).toEqual({ disposition: 'superseded' });
    expect(whereSql(runsUpdate).params).toEqual(expect.arrayContaining([ORG, 'entra', CHAIN, RUN, 'held', 'applying']));
  });

  it('suspect shrink: the run is recorded suspect_shrink and nothing else moves', async () => { // RF1
    h.results.push([{ id: RUN }], [{ directoryUserCount: 100 }], [{ outcome: 'evaluated', directoryUserCount: 100 }], []);
    const out = await recordEvaluatedRun(db, recordInput([ident(1)], () => ({ present: false }), { directoryUserCount: 50 }));
    expect(out).toMatchObject({ disposition: 'none', affected: 0 });
    expect(h.calls.filter((c) => c.op === 'execute')).toEqual([]);
    expect(insertsOf(portalDirectoryActions)).toEqual([]);
    expect(updatesOf(portalDirectoryActions)).toEqual([]);
    const runUpdates = updatesOf(portalDirectoryRuns);
    expect(runUpdates).toHaveLength(1);
    expect(firstArg(runUpdates[0], 'set')).toMatchObject({ outcome: 'suspect_shrink', disposition: 'none' });
  });

  it('dismiss sets rearm and the next run proposes nothing', async () => { // RF4, D8e
    mode.enforce = true;
    // The dismiss.
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'held', impactDigest: 'digest', snapshotAt: NOW, createdAt: NOW, decidedByUserId: null }],
      [{ identityId: uuid(1) }, { identityId: uuid(2) }],
    );
    await dismissHeldRun({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'digest', now: NOW });
    expect(firstArg(updatesOf(portalDirectoryActions)[0], 'set')).toEqual({ status: 'skipped', skipReason: 'dismissed' });
    expect(firstArg(updatesOf(portalUserIdentities)[0], 'set')).toEqual({ directoryRearmSince: NOW });
    expect(firstArg(updatesOf(portalDirectoryRuns)[0], 'set')).toMatchObject({ disposition: 'held_dismissed', decidedByUserId: ACTOR, decidedAt: NOW });
    expect(firstArg(insertsOf(auditLogs)[0], 'values')).toMatchObject({
      actorType: 'user', actorId: ACTOR, action: 'organization.portal_directory.run.dismiss', resourceType: 'portal_directory_run',
      resourceId: RUN, details: expect.objectContaining({ impactDigest: 'digest' }),
    });

    // The next snapshot still says disabled: the rearmed identities are listed, never proposed.
    h.calls.length = 0;
    h.results.length = 0;
    const rearm = { directoryRearmSince: NOW };
    scriptRecord({ updates: 2, chainApplied: true, accounts: [account(1), account(2)], usable: [] });
    const out = await recordEvaluatedRun(db, recordInput(
      [ident(1, rearm), ident(2, rearm)],
      () => ({ present: true, state: 'disabled', reason: 'account_disabled' }),
      { snapshotAt: new Date(NOW.getTime() + 3600_000) },
    ));
    expect(out).toMatchObject({ disposition: 'none', affected: 0, holdReason: null });
    await afterRunCommitted(out);
    expect(notifyDirectoryRunHeld).not.toHaveBeenCalled();
    expect(enqueueApplyRun).not.toHaveBeenCalled();
  });

  it('logs one line with counts only: no subject, email or name', async () => {
    const log = vi.mocked(console.log);
    scriptRecord({ updates: 1, accounts: [account(1)], usable: [] });
    await recordEvaluatedRun(db, recordInput([ident(1)], () => ({ present: true, state: 'disabled', reason: 'suspended' })));
    expect(log).toHaveBeenCalledTimes(1);
    const line = JSON.stringify(log.mock.calls[0]);
    expect(line).toContain('reported');
    expect(line).not.toMatch(/oid-1|@/);
  });
});

describe('applyRun and dismissHeldRun refusals', () => {
  const heldRun = (over: Record<string, unknown> = {}) => ({
    id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'held', impactDigest: 'digest',
    snapshotAt: new Date(NOW.getTime() - 3600_000), createdAt: new Date(NOW.getTime() - 3600_000), decidedByUserId: null, ...over,
  });
  const mspApply = (over: Record<string, unknown> = {}) =>
    decideHeldRunApply({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'digest', now: NOW, ...over });

  it('apply and dismiss refuse in report mode (PORTAL_DIRECTORY_ENFORCEMENT_OFF)', async () => { // D7
    for (const p of [mspApply(), applyRun({ orgId: ORG, runId: RUN, now: NOW }), dismissHeldRun({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'digest', now: NOW })]) {
      const err = await rejection(p);
      expect(err).toBeInstanceOf(PortalDirectoryIdentityError);
      expect(err).toMatchObject({ code: 'PORTAL_DIRECTORY_ENFORCEMENT_OFF', httpStatus: 409 });
    }
    expect(h.calls).toEqual([]);
  });

  it('another org\'s run, or a malformed id, is PORTAL_DIRECTORY_RUN_NOT_FOUND', async () => {
    mode.enforce = true;
    h.results.push([]);
    expect(await rejection(mspApply())).toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_FOUND', httpStatus: 404 });
    expect(await rejection(mspApply({ runId: 'x' }))).toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_FOUND', httpStatus: 404 });
  });

  it('a run that is not held is PORTAL_DIRECTORY_RUN_NOT_HELD for the MSP', async () => {
    mode.enforce = true;
    for (const disposition of ['reported', 'applying', 'applied', 'held_dismissed', 'superseded']) {
      h.results.push([{ source: 'entra' }], [], [heldRun({ disposition })]);
      expect(await rejection(mspApply())).toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_HELD', httpStatus: 409 });
    }
    expect(updatesOf(portalDirectoryRuns)).toEqual([]);
  });

  it('apply refuses a stale run: newer evaluated run, older than 72 h, digest mismatch, or chain org ≠ run org', async () => { // D8d
    mode.enforce = true;
    const cases: Array<[Record<string, unknown>, unknown[] | null, Record<string, unknown>]> = [
      [{}, [{ id: PREV_RUN }], {}],                                                                   // newer evaluated run
      [{ snapshotAt: new Date(NOW.getTime() - 73 * 3600_000) }, null, {}],                            // too old
      [{}, null, { impactDigest: 'other' }],                                 // digest
      [{ chainKey: entraChainKey({ tenantId: TID, connectionId: CONN, consentGeneration: 1, orgId: OTHER_ORG }) }, null, {}], // merged
    ];
    for (const [run, newer, over] of cases) {
      h.results.push([{ source: 'entra' }], [], [heldRun(run)]);
      if (newer) h.results.push(newer); // the newer-run query runs last, after the cheap checks
      expect(await rejection(mspApply(over))).toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_STALE', httpStatus: 409 });
    }
    expect(updatesOf(portalDirectoryRuns)).toEqual([]);
    expect(disablePortalIdentity).not.toHaveBeenCalled();
    expect(enqueueApplyRun).not.toHaveBeenCalled();
  });

  it('dismiss refuses a run that is not held, and a digest mismatch', async () => {
    mode.enforce = true;
    h.results.push([{ source: 'entra' }], [], [heldRun({ disposition: 'applying' })]);
    expect(await rejection(dismissHeldRun({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'digest', now: NOW })))
      .toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_NOT_HELD' });
    h.results.push([{ source: 'entra' }], [], [heldRun()]);
    expect(await rejection(dismissHeldRun({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'other', now: NOW })))
      .toMatchObject({ code: 'PORTAL_DIRECTORY_RUN_STALE' });
    expect(writes().filter((c) => c.op !== 'execute')).toEqual([]);
  });
});

describe('applyRun', () => {
  const action = (n: number, over: Record<string, unknown> = {}) =>
    ({ id: uuid(500 + n), identityId: uuid(n), provider: 'entra', reason: 'account_disabled', ...over });

  it('system: an applying run applies each pending action in its own transaction and ends applied', async () => {
    mode.enforce = true;
    vi.mocked(disablePortalIdentity)
      .mockResolvedValueOnce({ kind: 'disabled', portalUserId: userOf(1), accountDisabled: true, keepsPassword: false })
      .mockResolvedValueOnce({ kind: 'blocker_added', portalUserId: userOf(2), accountDisabled: false });
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'applying', impactDigest: 'd', snapshotAt: NOW, createdAt: NOW, decidedByUserId: null }],
      [action(1), action(2)],
    );
    const out = await applyRun({ orgId: ORG, runId: RUN, now: NOW });
    expect(out).toEqual({ applied: 2, skipped: 0 });
    expect(disablePortalIdentity).toHaveBeenCalledTimes(2);
    expect(vi.mocked(disablePortalIdentity).mock.calls[0]![0]).toMatchObject({
      orgId: ORG, identityId: uuid(1), blocker: 'entra_directory', reason: 'account_disabled', actionId: uuid(501),
      expect: { directoryChain: CHAIN, verifySource: expect.any(Function) },
    });
    // Each action's disable runs with no context held (it opens its own transaction).
    const loadActions = h.calls.find((c) => c.op === 'select' && stepsOf(c, 'from')[0]?.[0] === portalDirectoryActions);
    expect(whereSql(loadActions).params).toEqual(expect.arrayContaining(['held', 'pending']));
    const final = updatesOf(portalDirectoryRuns).at(-1);
    expect(firstArg(final, 'set')).toEqual({ disposition: 'applied' });
    expect(whereSql(final).params).toContain('applying');
  });

  it('system: a run no longer applying (superseded, finished) is a no-op', async () => {
    mode.enforce = true;
    h.results.push([{ source: 'entra' }], [], [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'superseded', impactDigest: 'd', snapshotAt: NOW, createdAt: NOW, decidedByUserId: null }]);
    expect(await applyRun({ orgId: ORG, runId: RUN, now: NOW })).toEqual({ applied: 0, skipped: 0 });
    expect(disablePortalIdentity).not.toHaveBeenCalled();
    expect(updatesOf(portalDirectoryRuns)).toEqual([]);
  });

  it('system: an applying run past 72 h or naming another org is superseded, never applied', async () => {
    mode.enforce = true;
    for (const run of [
      { snapshotAt: new Date(NOW.getTime() - 73 * 3600_000) },
      { chainKey: entraChainKey({ tenantId: TID, connectionId: CONN, consentGeneration: 1, orgId: OTHER_ORG }) },
    ]) {
      h.calls.length = 0;
      h.results.push([{ source: 'entra' }], [], [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'applying', impactDigest: 'd', snapshotAt: NOW, createdAt: NOW, decidedByUserId: null, ...run }]);
      expect(await applyRun({ orgId: ORG, runId: RUN, now: NOW })).toEqual({ applied: 0, skipped: 0 });
      expect(firstArg(updatesOf(portalDirectoryActions)[0], 'set')).toEqual({ status: 'superseded' });
      expect(firstArg(updatesOf(portalDirectoryRuns)[0], 'set')).toEqual({ disposition: 'superseded' });
    }
    expect(disablePortalIdentity).not.toHaveBeenCalled();
  });

  it('MSP: a held run is decided (applying, decided_by, audit with the digest) and committed; nothing is applied in the request', async () => { // D8d, D10
    mode.enforce = true;
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'held', impactDigest: 'digest', snapshotAt: NOW, createdAt: NOW, decidedByUserId: null }],
      [],             // no newer evaluated run
      [], [],         // decide update, audit
      [{ actions: 3 }],
    );
    const out = await decideHeldRunApply({ orgId: ORG, runId: RUN, actorUserId: ACTOR, impactDigest: 'digest', now: NOW });
    expect(out).toEqual({ runId: RUN, actions: 3 });
    const [decide, ...rest] = updatesOf(portalDirectoryRuns);
    expect(rest).toEqual([]);
    expect(firstArg(decide, 'set')).toEqual({ disposition: 'applying', decidedByUserId: ACTOR, decidedAt: NOW });
    expect(decide!.depth).toBe(1);
    expect(firstArg(insertsOf(auditLogs)[0], 'values')).toMatchObject({
      actorType: 'user', actorId: ACTOR, action: 'organization.portal_directory.run.apply', resourceType: 'portal_directory_run',
      resourceId: RUN, details: expect.objectContaining({ impactDigest: 'digest', source: 'entra' }),
    });
    // The count is of the actions still held, read in the decision's transaction.
    const count = h.calls.find((c) => c.op === 'select' && stepsOf(c, 'from')[0]?.[0] === portalDirectoryActions);
    expect(count!.depth).toBe(1);
    expect(whereSql(count).params).toContain('held');
    // The apply-run job applies; the request disables nobody and leaves the
    // enqueue to its caller, after this commit.
    expect(disablePortalIdentity).not.toHaveBeenCalled();
    expect(enqueueApplyRun).not.toHaveBeenCalled();
  });

  it('system: an MSP-decided applying run finishes held_applied and writes no second decision audit', async () => {
    mode.enforce = true;
    vi.mocked(disablePortalIdentity).mockResolvedValueOnce({ kind: 'disabled', portalUserId: userOf(1), accountDisabled: true, keepsPassword: false });
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'applying', impactDigest: 'digest', snapshotAt: NOW, createdAt: NOW, decidedByUserId: ACTOR }],
      [action(1)],
    );
    expect(await applyRun({ orgId: ORG, runId: RUN, now: NOW })).toEqual({ applied: 1, skipped: 0 });
    expect(updatesOf(portalDirectoryRuns).map((c) => firstArg(c, 'set'))).toEqual([{ disposition: 'held_applied' }]);
    expect(insertsOf(auditLogs)).toEqual([]);
  });

  it('apply re-checks each action: proof gone, connection re-consented, identity restored or re-chained ⇒ skipped with a reason', async () => {
    mode.enforce = true;
    const reasons = ['tenant_not_proven', 'connection_changed', 'rearmed', 'chain_changed'] as const;
    for (const reason of reasons) vi.mocked(disablePortalIdentity).mockResolvedValueOnce({ kind: 'skipped', reason });
    vi.mocked(disablePortalIdentity).mockResolvedValueOnce({ kind: 'skipped', reason: 'action_not_pending' });
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'applying', impactDigest: 'd', snapshotAt: NOW, createdAt: NOW, decidedByUserId: ACTOR }],
      [action(1), action(2), action(3), action(4), action(5)],
    );
    const out = await applyRun({ orgId: ORG, runId: RUN, now: NOW });
    expect(out).toEqual({ applied: 0, skipped: 4 });
    const skips = updatesOf(portalDirectoryActions);
    expect(skips.map((c) => firstArg(c, 'set'))).toEqual(reasons.map((r) => ({ status: 'skipped', skipReason: r })));
    // Only an action still awaiting application is marked.
    expect(whereSql(skips[0]).params).toEqual(expect.arrayContaining(['held', 'pending']));
    // MSP-approved run finished by the system path: held_applied.
    expect(firstArg(updatesOf(portalDirectoryRuns).at(-1), 'set')).toEqual({ disposition: 'held_applied' });
  });

  it('the kill switch is re-checked before each action: off mid-batch stops, leaves the rest un-applied and the run applying', async () => { // review fix
    mode.enforce = true;
    const log = vi.mocked(console.log);
    vi.mocked(disablePortalIdentity).mockImplementationOnce(async () => {
      // The operator turns enforcement off while the batch runs.
      mode.enforce = false;
      return { kind: 'disabled', portalUserId: userOf(1), accountDisabled: true, keepsPassword: false };
    });
    h.results.push(
      [{ source: 'entra' }], [],
      [{ id: RUN, orgId: ORG, source: 'entra', chainKey: CHAIN, disposition: 'applying', impactDigest: 'd', snapshotAt: NOW, createdAt: NOW, decidedByUserId: ACTOR }],
      [action(1), action(2), action(3)],
    );
    const out = await applyRun({ orgId: ORG, runId: RUN, now: NOW });
    expect(out).toEqual({ applied: 1, skipped: 0, halted: 'enforcement_off', remaining: 2 });
    expect(disablePortalIdentity).toHaveBeenCalledTimes(1);
    // Nothing marked skipped, and the run is left `applying` (no finishing update).
    expect(updatesOf(portalDirectoryActions)).toEqual([]);
    expect(updatesOf(portalDirectoryRuns)).toEqual([]);
    const line = JSON.stringify(log.mock.calls);
    expect(line).toContain('halted');
    expect(line).toMatch(/"remaining":2/);
  });
});

describe('verifyDirectorySource (D8d)', () => {
  const entraConn = (over: Record<string, unknown> = {}) => ({
    id: CONN, orgId: ORG, profile: 'customer-graph-read', status: 'active', revokedAt: null, tenantId: TID.toUpperCase(), consentGeneration: 1, ...over,
  });
  const chain = { source: 'entra' as const, tenantId: TID, connectionId: CONN, consentGeneration: 1, orgId: ORG };

  it('entra: an executable connection of the same incarnation and the proven tenant pass, both locked FOR SHARE', async () => {
    h.results.push([entraConn()], [{ tenantId: TID }]);
    expect(await verifyDirectorySource(chain, ORG)).toBeNull();
    const selects = h.calls.filter((c) => c.op === 'select');
    expect(selects.map((c) => stepsOf(c, 'for')[0])).toEqual([['share'], ['share']]);
  });

  it('entra: a degraded connection still passes', async () => {
    h.results.push([entraConn({ status: 'degraded' })], [{ tenantId: TID }]);
    expect(await verifyDirectorySource(chain, ORG)).toBeNull();
  });

  it.each([
    ['re-consented', { consentGeneration: 2 }],
    ['revoked', { revokedAt: NOW }],
    ['not executable', { status: 'revoked' }],
    ['another tenant', { tenantId: '99999999-2222-4333-8444-555555555555' }],
    ['another profile', { profile: 'partner-graph-read' }],
  ])('entra: a connection %s is connection_changed', async (_name, over) => {
    h.results.push([entraConn(over)]);
    expect(await verifyDirectorySource(chain, ORG)).toBe('connection_changed');
  });

  it('entra: a removed connection is connection_changed; a lost proof is tenant_not_proven', async () => {
    h.results.push([]);
    expect(await verifyDirectorySource(chain, ORG)).toBe('connection_changed');
    h.results.push([entraConn()], []);
    expect(await verifyDirectorySource(chain, ORG)).toBe('tenant_not_proven');
    h.results.push([entraConn()], [{ tenantId: '99999999-2222-4333-8444-555555555555' }]);
    expect(await verifyDirectorySource(chain, ORG)).toBe('tenant_not_proven');
  });

  it('google: the same connection id and binding pass; a re-bound or inactive connection is connection_changed', async () => {
    const conn = { id: CONN, orgId: ORG, status: 'active', adminEmail: 'admin@customer.test', serviceAccountEmail: 'sa@project.test' };
    const { googleConnectionBinding } = await import('../portalDomainVerification/checkers/googleBinding');
    const binding = googleConnectionBinding(conn);
    const gchain = { source: 'google' as const, customerId: 'C1', connectionId: CONN, binding, orgId: ORG };
    expect(googleChainKey(gchain)).toContain(binding);
    h.results.push([conn]);
    expect(await verifyDirectorySource(gchain, ORG)).toBeNull();
    h.results.push([{ ...conn, adminEmail: 'other@customer.test' }]);
    expect(await verifyDirectorySource(gchain, ORG)).toBe('connection_changed');
    h.results.push([{ ...conn, status: 'error' }]);
    expect(await verifyDirectorySource(gchain, ORG)).toBe('connection_changed');
  });

  it('an inactive org or partner is org_inactive', async () => {
    vi.mocked(getActiveOrgTenant).mockResolvedValueOnce(null);
    expect(await verifyDirectorySource(chain, ORG)).toBe('org_inactive');
  });
});

describe('pruneDirectoryRuns', () => {
  it('prune deletes empty runs after 30 days and others after 365', async () => {
    h.results.push([{ id: uuid(1) }, { id: uuid(2) }], [{ id: uuid(3) }]);
    expect(await pruneDirectoryRuns(NOW)).toBe(3);
    const deletes = h.calls.filter((c) => c.op === 'delete');
    expect(deletes).toHaveLength(2);
    expect(deletes.every((c) => c.args[0] === portalDirectoryRuns)).toBe(true);
    const [empty, all] = deletes.map((c) => whereSql(c));
    expect(empty!.sql).toMatch(/not exists/i);
    expect(empty!.params).toContain(new Date(NOW.getTime() - 30 * 86400_000).toISOString());
    expect(all!.sql).not.toMatch(/not exists/i);
    expect(all!.params).toContain(new Date(NOW.getTime() - 365 * 86400_000).toISOString());
  });
});
