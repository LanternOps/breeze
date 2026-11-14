import { beforeEach, describe, expect, it, vi } from 'vitest';

// The Google daily pass (portal registration W8, plan Task 7; D10, D11): the
// sweep's fan-out and evaluateGoogleOrg's decisions. The listing itself is
// googleSource.test.ts; the SQL is the integration suite's.

const h = vi.hoisted(() => ({
  queueAdd: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {},
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../tenantStatus', () => ({ getActiveOrgTenant: vi.fn() }));
vi.mock('../googleHelpers', () => ({ loadGoogleConnection: vi.fn(), decryptConnectionKey: vi.fn() }));
vi.mock('../googleClient', () => ({ getDirectoryUsersReader: vi.fn() }));
vi.mock('./runStore', () => ({
  recordRefusedRun: vi.fn(),
  recordEvaluatedRun: vi.fn(),
  afterRunCommitted: vi.fn(),
}));
vi.mock('./identityDisable', () => ({ lockPortalDirectorySource: vi.fn() }));
vi.mock('./queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./queue')>()),
  getPortalDirectoryQueue: () => ({ add: h.queueAdd }),
}));

import { googleConnectionBinding } from '../portalDomainVerification/checkers/googleBinding';
import type { DirectoryObservation, InScopeIdentity } from './evaluate';
import {
  evaluateGoogleOrg,
  googleOrgJobId,
  runGoogleSweep,
  type GoogleListing,
  type GoogleOrgDeps,
} from './googleSource';
import { PORTAL_DIRECTORY_GOOGLE_ORG_JOB, PORTAL_DIRECTORY_JOB_OPTS } from './queue';

const ORG = '11111111-1111-4111-8111-111111111111';
const ORG2 = '22222222-2222-4222-8222-222222222222';
const CONN = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';
const DATE = '2026-11-14';
const ADMIN = 'admin@customer.example.com';
const SA = 'breeze-dwd@project.iam.example.com';
const KEY = '{"private_key":"-----BEGIN PRIVATE KEY-----SECRETKEYMATERIAL"}';
const CUSTOMER = 'C0abc123';

function identity(subject: string, i: number): InScopeIdentity {
  return {
    identityId: `00000000-0000-4000-8000-00000000000${i}`, portalUserId: `00000000-0000-4000-8000-10000000000${i}`,
    provider: 'google', subject, directoryChain: null, directorySeenAt: null, directoryAbsentRuns: 0,
    directoryAbsentSince: null, directoryLastRunId: null, directoryRearmSince: null,
  };
}

const CONNECTION = { id: CONN, orgId: ORG, status: 'active', adminEmail: ADMIN, serviceAccountEmail: SA };

const completeListing = (): GoogleListing => ({
  kind: 'complete',
  customerId: CUSTOMER,
  users: new Map([
    ['g-on', { suspended: false, archived: false }],
    ['g-susp', { suspended: true, archived: false }],
    ['g-arch', { suspended: false, archived: true }],
    ['g-admin', { suspended: false, archived: false }],
  ]),
});

function makeDeps(over: Partial<GoogleOrgDeps> = {}) {
  const order: string[] = [];
  const deps: GoogleOrgDeps = {
    loadConnection: vi.fn(async () => { order.push('load'); return { ...CONNECTION }; }),
    decryptKey: vi.fn(() => KEY),
    makeReader: vi.fn(() => ({ getUser: vi.fn(), listUsersPage: vi.fn() })),
    hasIdentities: vi.fn(async () => { order.push('has-identities'); return true; }),
    list: vi.fn(async () => { order.push('list'); return completeListing(); }),
    transaction: vi.fn(async (fn) => { order.push('begin'); const r = await fn(); order.push('commit'); return r; }),
    lockSource: vi.fn(async () => { order.push('lock'); }),
    recheckConnection: vi.fn(async () => { order.push('recheck'); return { ...CONNECTION }; }),
    orgActive: vi.fn(async () => { order.push('org'); return true; }),
    loadIdentities: vi.fn(async () => {
      order.push('identities');
      return ['g-on', 'g-susp', 'g-arch', 'g-gone'].map((s, i) => identity(s, i));
    }),
    recordRefusedRun: vi.fn(async () => { order.push('refused'); }),
    recordEvaluatedRun: vi.fn(async () => {
      order.push('evaluated');
      return {
        runId: RUN_ID, orgId: ORG, source: 'google' as const, disposition: 'reported' as const, holdReason: null,
        affected: 2, usable: 4, created: true,
      };
    }),
    afterRunCommitted: vi.fn(async () => { order.push('after'); }),
    ...over,
  };
  return { deps, order };
}

beforeEach(() => {
  vi.restoreAllMocks();
  h.queueAdd.mockReset();
  h.queueAdd.mockResolvedValue(undefined);
});

describe('evaluateGoogleOrg (plan Task 7, D11)', () => {
  it('lists OUTSIDE the transaction, then records in one locked transaction, after-commit last', async () => {
    const { deps, order } = makeDeps();
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'evaluated' });
    expect(order).toEqual([
      'load', 'has-identities', 'list', 'begin', 'lock', 'recheck', 'org', 'identities', 'evaluated', 'commit', 'after',
    ]);
    expect(deps.makeReader).toHaveBeenCalledWith(KEY, ADMIN);
    expect(deps.lockSource).toHaveBeenCalledWith(ORG);
    expect(deps.recheckConnection).toHaveBeenCalledWith(ORG, CONN);
    const p = vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1];
    expect(p).toMatchObject({
      orgId: ORG,
      source: 'google',
      snapshotKey: `${CONN}:${DATE}`,
      chainKey: `google:${CUSTOMER}:${CONN}:${googleConnectionBinding(CONNECTION)}:${ORG}`,
      directoryUserCount: 4,
    });
    expect(p.identities).toHaveLength(4);
  });

  it('suspended and archived map to their reasons; a missing id is absent', async () => {
    const { deps } = makeDeps();
    await evaluateGoogleOrg(ORG, DATE, deps);
    const { observe } = vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1];
    const seen: Record<string, DirectoryObservation> = {};
    for (const s of ['g-on', 'g-susp', 'g-arch', 'g-gone']) seen[s] = observe(s);
    expect(seen).toEqual({
      'g-on': { present: true, state: 'enabled' },
      'g-susp': { present: true, state: 'disabled', reason: 'suspended' },
      'g-arch': { present: true, state: 'disabled', reason: 'archived' },
      'g-gone': { present: false },
    });
  });

  it('an incomplete listing records incomplete with its reason and acts on nobody', async () => {
    const { deps } = makeDeps({ list: vi.fn(async (): Promise<GoogleListing> => ({ kind: 'incomplete', reason: 'scope_missing' })) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'incomplete', reason: 'scope_missing' });
    expect(deps.recordRefusedRun).toHaveBeenCalledWith(expect.anything(), {
      orgId: ORG, source: 'google', snapshotKey: `${CONN}:${DATE}`, snapshotAt: expect.any(Date), outcome: 'incomplete', reason: 'scope_missing',
    });
    expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
    expect(deps.afterRunCommitted).not.toHaveBeenCalled();
  });

  it('a key that cannot be decrypted or parsed is incomplete connection_invalid, without a listing', async () => {
    const { deps } = makeDeps({ decryptKey: vi.fn(() => { throw new Error('could not be decrypted'); }) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'incomplete', reason: 'connection_invalid' });
    expect(deps.list).not.toHaveBeenCalled();
    const bad = makeDeps({ makeReader: vi.fn(() => { throw new Error('bad key json'); }) });
    expect(await evaluateGoogleOrg(ORG, DATE, bad.deps)).toEqual({ outcome: 'incomplete', reason: 'connection_invalid' });
  });

  it('a key failure is logged with the error class and org id only, never its message', async () => { // review fix
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { deps } = makeDeps({ decryptKey: vi.fn(() => { throw Object.assign(new SyntaxError(`bad ${KEY}`), { code: 'ERR_KEY' }); }) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'incomplete', reason: 'connection_invalid' });
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/google reader/), { orgId: ORG, stage: 'key', error: 'SyntaxError', code: 'ERR_KEY' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRETKEYMATERIAL');
  });

  it('a listing that throws (network) is mapped by the Google error mapper, not mislabelled connection_invalid', async () => { // review fix
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const net = makeDeps({ list: vi.fn(async () => { throw Object.assign(new Error(`socket hang up ${ADMIN}`), { code: 'ECONNRESET' }); }) });
    expect(await evaluateGoogleOrg(ORG, DATE, net.deps)).toEqual({ outcome: 'incomplete', reason: 'unavailable' });
    expect(net.deps.recordRefusedRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'incomplete', reason: 'unavailable' }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/google reader/), { orgId: ORG, stage: 'list', error: 'Error', code: 'ECONNRESET' });
    const denied = makeDeps({ list: vi.fn(async () => { throw Object.assign(new Error('forbidden'), { code: 403 }); }) });
    expect(await evaluateGoogleOrg(ORG, DATE, denied.deps)).toEqual({ outcome: 'incomplete', reason: 'access_denied' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(ADMIN);
  });

  it('a re-bound connection (new admin or service account) starts a new chain', async () => {
    const rebound = { ...CONNECTION, adminEmail: 'other-admin@customer.example.com' };
    const { deps } = makeDeps({
      loadConnection: vi.fn(async () => ({ ...rebound })),
      recheckConnection: vi.fn(async () => ({ ...rebound })),
    });
    await evaluateGoogleOrg(ORG, DATE, deps);
    const { chainKey } = vi.mocked(deps.recordEvaluatedRun).mock.calls[0]![1];
    expect(chainKey).toBe(`google:${CUSTOMER}:${CONN}:${googleConnectionBinding(rebound)}:${ORG}`);
    expect(chainKey).not.toContain(googleConnectionBinding(CONNECTION));
  });

  it('a connection re-bound, removed or deactivated while listing is skipped (the listing is not its evidence)', async () => {
    for (const now of [
      { ...CONNECTION, serviceAccountEmail: 'new-sa@project.iam.example.com' },
      { ...CONNECTION, status: 'inactive' },
      null,
    ]) {
      const { deps } = makeDeps({ recheckConnection: vi.fn(async () => now) });
      expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'skipped', reason: 'connection_inactive' });
      expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
      expect(deps.recordRefusedRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outcome: 'skipped', reason: 'connection_inactive' }));
    }
  });

  it('an inactive org or partner is skipped org_inactive', async () => {
    const { deps } = makeDeps({ orgActive: vi.fn(async () => false) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'skipped', reason: 'org_inactive' });
  });

  it('no connection, or an inactive one, is skipped with no run row and no listing', async () => {
    for (const conn of [null, { ...CONNECTION, status: 'inactive' }]) {
      const { deps } = makeDeps({ loadConnection: vi.fn(async () => conn) });
      expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'skipped', reason: 'connection_inactive' });
      expect(deps.list).not.toHaveBeenCalled();
      expect(deps.recordRefusedRun).not.toHaveBeenCalled();
    }
  });

  it('no enabled Google identity exits before reading the directory', async () => {
    const { deps } = makeDeps({ hasIdentities: vi.fn(async () => false) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'no_identities' });
    expect(deps.decryptKey).not.toHaveBeenCalled();
    expect(deps.list).not.toHaveBeenCalled();
    expect(deps.transaction).not.toHaveBeenCalled();
  });

  it('a partial deps override keeps the default legs for everything it does not name (the integration seam)', async () => {
    // Only the "has identities" leg is replaced; the connection load is the
    // default one (googleHelpers.loadGoogleConnection, mocked above).
    const { loadGoogleConnection } = await import('../googleHelpers');
    vi.mocked(loadGoogleConnection).mockResolvedValueOnce({ ...CONNECTION } as never);
    const hasIdentities = vi.fn(async () => false);
    expect(await evaluateGoogleOrg(ORG, DATE, { hasIdentities })).toEqual({ outcome: 'no_identities' });
    expect(loadGoogleConnection).toHaveBeenCalledWith(ORG);
    expect(hasIdentities).toHaveBeenCalledWith(ORG);
  });

  it('identities gone by the time of the transaction: no run row', async () => {
    const { deps } = makeDeps({ loadIdentities: vi.fn(async () => []) });
    expect(await evaluateGoogleOrg(ORG, DATE, deps)).toEqual({ outcome: 'no_identities' });
    expect(deps.recordEvaluatedRun).not.toHaveBeenCalled();
  });

  it('a malformed date or org id is refused before any read', async () => {
    const { deps } = makeDeps();
    await expect(evaluateGoogleOrg(ORG, '2026-11-14T00:00', deps)).rejects.toThrow();
    await expect(evaluateGoogleOrg('not-a-uuid', DATE, deps)).rejects.toThrow();
    expect(deps.loadConnection).not.toHaveBeenCalled();
  });

  it('no subject, email or key reaches a log line', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    for (const over of [
      {},
      { list: vi.fn(async (): Promise<GoogleListing> => ({ kind: 'incomplete', reason: 'access_denied' })) },
      { decryptKey: vi.fn(() => { throw new Error(`bad ${KEY}`); }) },
      { recordEvaluatedRun: vi.fn(async () => { throw new Error(`insert ${ADMIN} g-susp`); }) },
    ] as Array<Partial<GoogleOrgDeps>>) {
      const { deps } = makeDeps(over);
      await evaluateGoogleOrg(ORG, DATE, deps).catch(() => undefined);
    }
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).toContain(ORG);
    for (const secret of [ADMIN, SA, 'SECRETKEYMATERIAL', 'g-susp', 'g-on', CUSTOMER]) expect(logged).not.toContain(secret);
  });

  it('an unexpected failure is rethrown with no message content, for the job retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { deps } = makeDeps({ recordEvaluatedRun: vi.fn(async () => { throw new Error(`insert ${ADMIN}`); }) });
    const err = await evaluateGoogleOrg(ORG, DATE, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(ADMIN);
  });
});

describe('runGoogleSweep (plan D10)', () => {
  it('enqueues one google-org job per candidate org, keyed per UTC day', async () => {
    const now = new Date('2026-11-14T23:30:00.000Z');
    const out = await runGoogleSweep(now, { listCandidateOrgs: vi.fn(async () => [ORG, ORG2]) });
    expect(out).toEqual({ enqueued: 2 });
    expect(h.queueAdd).toHaveBeenCalledTimes(2);
    expect(h.queueAdd).toHaveBeenCalledWith(
      PORTAL_DIRECTORY_GOOGLE_ORG_JOB,
      { orgId: ORG, utcDate: '2026-11-14' },
      { ...PORTAL_DIRECTORY_JOB_OPTS, jobId: `portal-dir-google-${ORG}-2026-11-14` },
    );
    expect(googleOrgJobId(ORG2, '2026-11-15')).toBe(`portal-dir-google-${ORG2}-2026-11-15`);
    expect(googleOrgJobId(ORG, '2026-11-14')).not.toContain(':');
  });

  it('a failed enqueue is counted out, logged with the org id only, and does not stop the fan-out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.queueAdd.mockRejectedValueOnce(new Error('redis down'));
    const out = await runGoogleSweep(new Date('2026-11-14T01:00:00Z'), { listCandidateOrgs: vi.fn(async () => [ORG, ORG2]) });
    expect(out).toEqual({ enqueued: 1 });
    expect(JSON.stringify(error.mock.calls)).toContain(ORG);
  });

  it('no candidate org enqueues nothing', async () => {
    expect(await runGoogleSweep(new Date(), { listCandidateOrgs: vi.fn(async () => []) })).toEqual({ enqueued: 0 });
    expect(h.queueAdd).not.toHaveBeenCalled();
  });
});
