import { beforeEach, describe, expect, it, vi } from 'vitest';

// The parameter lists are declared, not inferred: a bare `vi.fn(async () => …)`
// infers a ZERO-argument signature, which makes every `.mock.calls[n][i]` read
// below a tsc error (the calls tuple is `[]`). Vitest transpiles without
// typechecking, so those errors only ever surface in `tsc --noEmit`.
const { queueAdd, getRepeatableJobs, removeRepeatableByKey, queueClose, workerCtor, workerClose } = vi.hoisted(() => ({
  queueAdd: vi.fn(async (_name: string, _data: unknown, _opts?: unknown) => ({ id: 'j1' })),
  getRepeatableJobs: vi.fn(async (): Promise<Array<{ name: string; key: string }>> => []),
  removeRepeatableByKey: vi.fn(async (_key: string) => undefined),
  queueClose: vi.fn(async () => undefined),
  workerCtor: vi.fn((_name: string, _processor: unknown, _opts: unknown) => undefined),
  workerClose: vi.fn(async () => undefined),
}));
vi.mock('bullmq', () => ({
  Queue: class {
    add = queueAdd;
    getRepeatableJobs = getRepeatableJobs;
    removeRepeatableByKey = removeRepeatableByKey;
    close = queueClose;
  },
  Worker: class {
    constructor(name: string, processor: unknown, opts: unknown) { workerCtor(name, processor, opts); }
    on = vi.fn();
    close = workerClose;
  },
}));

const { execRows, updates, deletes, selectWheres } = vi.hoisted(() => ({
  execRows: [] as unknown[][],
  updates: [] as Record<string, unknown>[],
  deletes: [] as unknown[],
  selectWheres: [] as unknown[],
}));
vi.mock('../db', () => ({
  db: {
    execute: vi.fn(async () => ({ rows: execRows.shift() ?? [] })),
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const m of ['from', 'limit', 'innerJoin']) chain[m] = vi.fn(() => chain);
      chain.where = vi.fn((w: unknown) => { selectWheres.push(w); return chain; });
      (chain as { then: unknown }).then = (r: (v: unknown) => unknown) =>
        Promise.resolve(execRows.shift() ?? []).then(r);
      return chain;
    }),
    update: vi.fn(() => ({ set: vi.fn((v: Record<string, unknown>) => { updates.push(v); return { where: vi.fn(async () => undefined) }; }) })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { deletes.push(w); }) })),
  },
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

const { syncMock, markStaticVerifiedMock } = vi.hoisted(() => ({
  syncMock: vi.fn(async () => 'polled'),
  markStaticVerifiedMock: vi.fn(async () => true),
}));
vi.mock('../services/emailDomains/domainSync', () => ({
  syncSendingDomain: syncMock,
  markStaticDomainVerified: markStaticVerifiedMock,
  FAILED_RETRY_WINDOW_MS: 72 * 60 * 60 * 1000,
}));

const { providerMock, getProviderMock } = vi.hoisted(() => {
  const providerMock = {
    id: 'fake' as const, verifiesByDns: true,
    createDomain: vi.fn(), findDomainByName: vi.fn(), getDomain: vi.fn(),
    requestVerification: vi.fn(), deleteDomain: vi.fn(),
    listDomains: vi.fn(async (): Promise<Array<{ providerDomainId: string; domain: string }>> => []),
    send: vi.fn(async (_message: unknown) => ({ providerMessageId: 'm1' })),
  };
  return { providerMock, getProviderMock: vi.fn(() => providerMock as unknown) };
});
vi.mock('../services/emailDomains/providerRegistry', () => ({ getEmailDomainProvider: getProviderMock }));

const { laneConfigured } = vi.hoisted(() => ({ laneConfigured: { value: true } }));
vi.mock('../services/emailDomains/config', () => ({
  isPartnerLaneConfigured: () => laneConfigured.value,
  getEmailDomainsConfig: () => ({
    provider: laneConfigured.value ? 'fake' : null,
    resendApiKey: null, resendSendingKey: null,
    region: 'us-east-1', maxPerPartner: 3, dailySendCap: 0,
    partnerAllowlist: [], denylist: [], staticAllowed: [], webhookSecret: null,
  }),
  findStaticAllowedEntry: () => null,
}));

const { opsAlertMock } = vi.hoisted(() => ({ opsAlertMock: vi.fn(async () => true) }));
vi.mock('../services/opsAlerts', () => ({ sendOpsAlert: opsAlertMock, isOpsAlertingConfigured: () => true }));

const { hostedFlag } = vi.hoisted(() => ({ hostedFlag: { value: false } }));
vi.mock('../config/env', () => ({ isHosted: () => hostedFlag.value }));

const { probeRecord, probeRead } = vi.hoisted(() => ({
  probeRecord: vi.fn(async () => undefined),
  probeRead: vi.fn(async () => null),
}));
vi.mock('../services/emailDomains/keyProbe', () => ({
  recordProviderKeyProbe: probeRecord, readProviderKeyProbe: probeRead,
}));

const { tryCountPartnerLaneSendMock } = vi.hoisted(() => ({
  tryCountPartnerLaneSendMock: vi.fn(async () => true),
}));
vi.mock('../services/emailDomains/sendCap', () => ({
  tryCountPartnerLaneSend: tryCountPartnerLaneSendMock,
  recordPartnerLaneCapHit: vi.fn(),
  partnerLaneCapKey: vi.fn(() => 'k'),
}));

vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

const { evaluateAutoSuspendMock } = vi.hoisted(() => ({
  evaluateAutoSuspendMock: vi.fn(async (_partnerId: string) => ({ outcome: 'below_thresholds', suspendedDomainIds: [] })),
}));
vi.mock('../services/emailDomains/autoSuspend', () => ({ evaluateAutoSuspension: evaluateAutoSuspendMock }));

import { PartnerLaneSendFailure, ProviderManagementAuthError } from '../services/emailDomains/provider';
import {
  SENDING_DOMAINS_QUEUE, enqueueAutoSuspendEvaluation, enqueueSyncDomain, enqueueTestSend,
  initializeSendingDomainsWorker, runDailyMaintenance, runSendingDomainsSweep, runTestSend,
  shutdownSendingDomainsWorker,
} from './sendingDomainsWorker';

const DOMAIN_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';
const PARTNER_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(async () => {
  await shutdownSendingDomainsWorker();
  vi.clearAllMocks();
  execRows.length = 0; updates.length = 0; deletes.length = 0; selectWheres.length = 0;
  laneConfigured.value = true;
  hostedFlag.value = false;
  providerMock.verifiesByDns = true;
  getProviderMock.mockReturnValue(providerMock as unknown);
  getRepeatableJobs.mockResolvedValue([]);
  // `vi.clearAllMocks()` clears CALLS, not implementations, so every one-off
  // `mockRejectedValue` below would otherwise leak into the tests that follow
  // it (a rejected `send` made two later static cases read as 'refused').
  tryCountPartnerLaneSendMock.mockResolvedValue(true);
  providerMock.listDomains.mockResolvedValue([]);
  providerMock.send.mockResolvedValue({ providerMessageId: 'm1' });
  providerMock.deleteDomain.mockResolvedValue(undefined);
  providerMock.findDomainByName.mockResolvedValue(null);
});

/**
 * The text of a Drizzle `sql` template. It cannot be JSON.stringify'd — the
 * embedded column references close a cycle through their own table — so the
 * string chunks and bound params are read off the tagged object instead.
 */
function sqlTextOf(query: any): string {
  return (query?.queryChunks ?? [])
    .map((chunk: any) => {
      // A plain interpolated number/string is stored as the primitive itself,
      // a literal fragment as a StringChunk, and a column/table as an object
      // that carries no text at all.
      if (typeof chunk === 'string' || typeof chunk === 'number') return String(chunk);
      if (Array.isArray(chunk?.value)) return chunk.value.join('');
      if (typeof chunk?.value === 'string' || typeof chunk?.value === 'number') return String(chunk.value);
      return '';
    })
    .join(' ');
}

describe('worker registration', () => {
  it('does not construct a Worker when no provider is configured (the dark default)', async () => {
    laneConfigured.value = false;
    await initializeSendingDomainsWorker();
    expect(workerCtor).not.toHaveBeenCalled();
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('constructs one Worker on the sending-domains queue, limited to 5 provider calls a second', async () => {
    await initializeSendingDomainsWorker();
    expect(workerCtor).toHaveBeenCalledTimes(1);
    const [name, , opts] = workerCtor.mock.calls[0] as [string, unknown, Record<string, unknown>];
    expect(name).toBe(SENDING_DOMAINS_QUEUE);
    expect(opts.limiter).toEqual({ max: 5, duration: 1000 });
    expect(opts.concurrency).toBe(1);
  });

  it('schedules the 60s sweep and the daily job by CRON, never a coarse `every`', async () => {
    await initializeSendingDomainsWorker();
    const sweep = queueAdd.mock.calls.find(([n]) => n === 'sweep')![2] as Record<string, any>;
    expect(sweep.repeat).toEqual({ every: 60_000 });
    const dailyOpts = queueAdd.mock.calls
      .filter(([n]) => n === 'daily-maintenance')
      .map((c) => c[2] as Record<string, any>);
    expect(dailyOpts.length).toBeGreaterThan(0);
    // A cron pattern, and NEVER a coarse `every` — scheduleRegistry.contract.test.ts
    // fails the build for one, and an epoch-anchored 24h repeat stampedes at 00:00 UTC.
    expect(dailyOpts.some((o) => typeof o.repeat?.pattern === 'string')).toBe(true);
    expect(dailyOpts.every((o) => o.repeat?.every === undefined)).toBe(true);
  });

  it('also enqueues one un-repeated daily-maintenance at boot so a static delist is caught on start', async () => {
    await initializeSendingDomainsWorker();
    const oneShots = queueAdd.mock.calls.filter(([n, , o]) => n === 'daily-maintenance' && (o as any).repeat === undefined);
    expect(oneShots).toHaveLength(1);
  });

  it('probes the management key exactly once on start and records send_only on a permission error', async () => {
    // The adapter, not the worker, decides that a 401/restricted_api_key is a
    // key refusal — the worker keys off the TYPE so a slow provider at boot
    // cannot be mistaken for one.
    providerMock.listDomains.mockRejectedValue(new ProviderManagementAuthError('listDomains', 'restricted_api_key'));
    await initializeSendingDomainsWorker();
    expect(providerMock.listDomains).toHaveBeenCalledTimes(1);
    expect(probeRecord).toHaveBeenCalledWith('send_only');
  });

  it('leaves the verdict alone when the boot probe cannot reach the provider', async () => {
    providerMock.listDomains.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
    await initializeSendingDomainsWorker();
    expect(probeRecord).not.toHaveBeenCalled();
  });

  it('records ok when the key can list domains', async () => {
    await initializeSendingDomainsWorker();
    expect(probeRecord).toHaveBeenCalledWith('ok');
  });
});

describe('enqueue helpers', () => {
  it('collapses duplicate sync jobs by using the domain id as the jobId', async () => {
    await enqueueSyncDomain(DOMAIN_ID);
    const [name, data, opts] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(name).toBe('sync-domain');
    expect(data).toEqual({ domainId: DOMAIN_ID });
    expect(opts.jobId).toBe(DOMAIN_ID);
  });

  it('carries the send refusal through so the worker, not the send path, writes last_send_error', async () => {
    await enqueueSyncDomain(DOMAIN_ID, { lastSendError: '550 sender not allowed' });
    const [, data] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(data).toEqual({ domainId: DOMAIN_ID, lastSendError: '550 sender not allowed' });
  });

  it('enqueues a test send addressed to the requesting user', async () => {
    await enqueueTestSend(DOMAIN_ID, USER_ID);
    const [name, data] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(name).toBe('test-send');
    expect(data).toEqual({ domainId: DOMAIN_ID, userId: USER_ID });
  });

  // A deterministic jobId plus a RETAINED completed/failed set is the
  // accountingSyncWorker.ts:314-330 trap: BullMQ silently drops an `add()`
  // whose jobId still sits in those sets, so the second "Check now" for a
  // domain would be a no-op the route still reports as queued.
  it.each([
    ['sync-domain', () => enqueueSyncDomain(DOMAIN_ID)],
    ['test-send', () => enqueueTestSend(DOMAIN_ID, USER_ID)],
  ])('drops %s job records immediately, so a later enqueue for the same id is never swallowed', async (_name, enqueue) => {
    await enqueue();
    const [, , opts] = queueAdd.mock.calls.at(-1) as [string, any, any];
    expect(opts.removeOnComplete).toBe(true);
    expect(opts.removeOnFail).toBe(true);
  });

  it('accepts a second sync for a domain whose previous job already completed', async () => {
    // The fake queue cannot model BullMQ's dedup, so this pins the property
    // that makes dedup harmless: nothing is retained under the id.
    const completedIds = new Set<string>();
    queueAdd.mockImplementation(async (_name: string, _data: unknown, opts?: any) => {
      const id = opts?.jobId as string | undefined;
      if (id && completedIds.has(id)) throw new Error(`BullMQ would drop the duplicate jobId ${id}`);
      if (id && opts?.removeOnComplete !== true) completedIds.add(id);
      return { id: 'j1' };
    });

    await enqueueSyncDomain(DOMAIN_ID);
    await expect(enqueueSyncDomain(DOMAIN_ID)).resolves.toBeUndefined();
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });

  it('is inert when the lane is unconfigured, so a stale route can never queue work', async () => {
    laneConfigured.value = false;
    await enqueueSyncDomain(DOMAIN_ID);
    await enqueueTestSend(DOMAIN_ID, USER_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });
});

describe('sweep', () => {
  it('claims at most 25 due rows with FOR UPDATE SKIP LOCKED and enqueues one job each', async () => {
    execRows.push([{ id: 'd1' }, { id: 'd2' }]);   // due rows
    execRows.push([]);                             // outbox rows
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.enqueued).toBe(2);
    const { db } = await import('../db');
    const sqlText = sqlTextOf((db.execute as any).mock.calls[0][0]);
    // Control: the extractor really read this statement, so the two assertions
    // below cannot pass against an empty string.
    expect(sqlText).toContain('select id');
    expect(sqlText).toContain('for update skip locked');
    expect(sqlText).toContain('25');
  });

  it('drains a due outbox row by deleting the provider domain, then the row', async () => {
    execRows.push([]);                                                        // no due domains
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 0 }]);
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(providerMock.deleteDomain).toHaveBeenCalledWith('pd-1');
    expect(result.released).toBe(1);
    expect(deletes).toHaveLength(1);
  });

  it('backs an outbox row off instead of deleting it when the provider refuses', async () => {
    execRows.push([]);
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 2 }]);
    providerMock.deleteDomain.mockRejectedValue(new Error('provider 503'));
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.released).toBe(0);
    expect(deletes).toHaveLength(0);
    expect(updates.at(-1)).toMatchObject({ attempts: 3 });
    expect(updates.at(-1)!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('raises an ops alert for an outbox row stuck past ten attempts and stops retrying it', async () => {
    execRows.push([]);
    execRows.push([{ id: 'r1', provider: 'fake', provider_domain_id: 'pd-1', attempts: 10 }]);
    const result = await runSendingDomainsSweep(new Date('2026-09-17T12:00:00Z'));
    expect(result.stuck).toBe(1);
    expect(opsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('release') }));
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });
});

describe('test send (spec §6.1)', () => {
  it('sends from the support identity local part, to the requesting user, tagged as a test', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');

    expect(providerMock.send).toHaveBeenCalledWith(expect.objectContaining({
      from: 'help@mail.acme.test',
      to: 'tech@acme.test',
      tags: expect.objectContaining({ purpose: 'sending_domain.test', domain_id: DOMAIN_ID }),
    }));
    expect(updates.at(-1)).toMatchObject({ lastTestStatus: 'sent' });
  });

  it('falls back to a `test` local part when no support identity exists', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);
    await runTestSend(DOMAIN_ID, USER_ID);
    expect(providerMock.send).toHaveBeenCalledWith(expect.objectContaining({ from: 'test@mail.acme.test' }));
  });

  // Only a RELAY REFUSAL is a verdict about the domain. `domain_unusable` and
  // `message_rejected` are; `ambiguous` and `lane_unavailable` are not.
  it.each([
    ['domain_unusable'],
    ['message_rejected'],
  ])('records a %s refusal verbatim and does not verify anything', async (kind) => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);
    providerMock.send.mockRejectedValue(
      new PartnerLaneSendFailure({ kind, detail: '550 5.7.60 sender not allowed' } as never),
    );

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');

    expect(updates.at(-1)).toMatchObject({ lastTestStatus: 'failed', lastTestError: expect.stringContaining(kind) });
    expect(markStaticVerifiedMock).not.toHaveBeenCalled();
  });

  // Recording these as `failed` told the partner "your domain could not send"
  // for a blip on OUR side, and swallowed the error so the job's retry never
  // engaged. They must rethrow and leave last_test_* untouched.
  it.each([
    ['an ambiguous lane failure', new PartnerLaneSendFailure({ kind: 'ambiguous', detail: 'timeout' } as never)],
    ['a lane_unavailable failure', new PartnerLaneSendFailure({ kind: 'lane_unavailable', detail: 'no key' } as never)],
    ['a non-PartnerLaneSendFailure exception', new Error('ECONNRESET')],
  ])('rethrows %s instead of recording a failed test', async (_label, err) => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);
    providerMock.send.mockRejectedValue(err);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).rejects.toThrow();

    expect(updates.some((u) => u.lastTestStatus === 'failed')).toBe(false);
  });

  // Spec §7: the test goes to the calling user's own VERIFIED address. Without
  // this the test send is a free relay to any address a partner adds to their
  // own account, from a domain nobody has proven they control.
  it('never sends for a missing/inactive/foreign recipient, and writes nothing', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([]);                       // the scoped lookup finds nobody
    execRows.push([]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('skipped');
    expect(providerMock.send).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  // A user who exists and is active but hasn't verified their own email is
  // actionable, unlike a missing user — the partner UI polls for a test result,
  // so silently doing nothing left them stuck. This records a reason instead.
  it('refuses and records a reason when the recipient exists but is not email-verified', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: null }]);
    execRows.push([]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');

    expect(providerMock.send).not.toHaveBeenCalled();
    expect(markStaticVerifiedMock).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      lastTestStatus: 'failed',
      lastTestError: expect.stringContaining('not verified'),
    });
  });

  it('skips a domain that is not sendable, and a static PENDING one is sendable', async () => {
    for (const status of ['provisioning', 'pending', 'failed', 'suspended', 'removing']) {
      vi.clearAllMocks();
      execRows.length = 0;
      execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status }]);
      execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
      execRows.push([]);
      await expect(runTestSend(DOMAIN_ID, USER_ID), status).resolves.toBe('skipped');
      expect(providerMock.send, status).not.toHaveBeenCalled();
    }

    vi.clearAllMocks();
    providerMock.verifiesByDns = false;   // static
    execRows.length = 0;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');
  });

  it('an accepted static test send verifies the row THERE, not through a sync job', async () => {
    providerMock.verifiesByDns = false;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);

    await runTestSend(DOMAIN_ID, USER_ID);

    // A sync would read `pending` from the static adapter and treat it as no
    // change (W02 amendment 5), leaving the row pending forever.
    expect(markStaticVerifiedMock).toHaveBeenCalledWith(DOMAIN_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('never sends for a user who is not in the domain\'s partner', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([]);   // the users lookup is scoped to the domain's partner
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('skipped');
    expect(providerMock.send).not.toHaveBeenCalled();
  });

  // Spec §6.1: "It counts against the daily cap." W03 left the wiring to W04
  // (its amendment 7); this is the assertion that it landed.
  it('consumes a cap slot for the domain partner before sending', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('sent');
    expect(tryCountPartnerLaneSendMock).toHaveBeenCalledWith('p1');
    expect(providerMock.send).toHaveBeenCalledTimes(1);
  });

  it('records the cap refusal on the row and never reaches the provider', async () => {
    tryCountPartnerLaneSendMock.mockResolvedValue(false);
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'verified' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([{ localPart: 'help' }]);

    // 'refused', not 'skipped': every skipped branch writes nothing to the row,
    // and this one writes last_test_*.
    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');
    expect(providerMock.send).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      lastTestStatus: 'failed',
      lastTestError: expect.stringContaining('daily send cap'),
    });
  });

  // A row that could never send must not burn a slot: the counter is the abuse
  // control, and a partner should not be able to exhaust their own cap by
  // pressing "test" on a failed domain.
  it('checks the cap AFTER the sendable guard', async () => {
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'failed' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([{ localPart: 'help' }]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('skipped');
    expect(tryCountPartnerLaneSendMock).not.toHaveBeenCalled();
  });

  // The relay accepting the message is the ONLY proof Breeze can obtain that it
  // may send as a `static` domain (spec §5.1). A capped send hands the relay
  // nothing, so it must not verify the row.
  it('a capped STATIC test send does not verify the domain', async () => {
    tryCountPartnerLaneSendMock.mockResolvedValue(false);
    providerMock.verifiesByDns = false;
    execRows.push([{ id: DOMAIN_ID, partnerId: 'p1', domain: 'mail.acme.test', status: 'pending' }]);
    execRows.push([{ email: 'tech@acme.test', emailVerifiedAt: new Date() }]);
    execRows.push([]);

    await expect(runTestSend(DOMAIN_ID, USER_ID)).resolves.toBe('refused');
    expect(providerMock.send).not.toHaveBeenCalled();
    expect(markStaticVerifiedMock).not.toHaveBeenCalled();
  });
});

describe('daily maintenance', () => {
  it('runs the drift report on HOSTED only', async () => {
    hostedFlag.value = false;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-x', domain: 'ghost.test' }]);
    execRows.push([]);
    await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(providerMock.listDomains).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('alerts on a provider domain older than 24h that no local row or outbox row explains — and deletes nothing', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([
      { providerDomainId: 'pd-known', domain: 'known.test' },
      { providerDomainId: 'pd-ghost', domain: 'ghost.test' },
    ]);
    execRows.push([{ provider_domain_id: 'pd-known' }]);  // local rows + outbox, one query
    // listDomains carries no createdAt (W02 pins the interface), so the age
    // comes from a second lookup — made only for the unaccounted-for domain.
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-ghost', state: 'verified', records: [], createdAt: new Date('2026-09-10T00:00:00Z'),
    });

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(providerMock.findDomainByName).toHaveBeenCalledTimes(1);
    expect(providerMock.findDomainByName).toHaveBeenCalledWith('ghost.test');
    expect(result.drift).toBe(1);
    expect(opsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining('ghost.test') }));
    expect(providerMock.deleteDomain).not.toHaveBeenCalled();
  });

  it('does not flag a provider domain created in the last 24h — it may be mid-provision', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-fresh', domain: 'fresh.test' }]);
    execRows.push([]);
    providerMock.findDomainByName.mockResolvedValue({
      providerDomainId: 'pd-fresh', state: 'pending', records: [], createdAt: new Date('2026-09-17T11:00:00Z'),
    });

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(result.drift).toBe(0);
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('flags a candidate whose creation time cannot be read, rather than suppressing it', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-opaque', domain: 'opaque.test' }]);
    execRows.push([]);
    providerMock.findDomainByName.mockRejectedValue(new Error('provider 500'));

    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));

    expect(result.drift).toBe(1);
    expect(opsAlertMock).toHaveBeenCalled();
  });

  // A `send_only` verdict degrades `provider_key_send_only` for EVERY partner
  // until the 25h TTL expires: no partner can add a domain. The old code wrote
  // it for ANY throw from a try that also wrapped a DB read and sendOpsAlert,
  // so one network blip or Postgres hiccup locked the whole platform out.
  it('records send_only ONLY for a classified management-key refusal', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockRejectedValue(new ProviderManagementAuthError('listDomains', 'restricted_api_key'));
    await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(probeRecord).toHaveBeenCalledWith('send_only');
  });

  it('leaves the probe verdict UNTOUCHED when listDomains fails transiently', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' }));
    await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(probeRecord).not.toHaveBeenCalled();
    expect(opsAlertMock).not.toHaveBeenCalled();
  });

  it('records ok on a successful list', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([]);
    execRows.push([]);
    await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(probeRecord).toHaveBeenCalledWith('ok');
    expect(probeRecord).not.toHaveBeenCalledWith('send_only');
  });

  // The DB read and the ops alert moved OUT of the listDomains try. A failure
  // in either must surface (BullMQ retries the job), never be relabelled as a
  // key permission verdict.
  it('does not turn a DB failure during the drift read into a send_only verdict', async () => {
    hostedFlag.value = true;
    providerMock.listDomains.mockResolvedValue([{ providerDomainId: 'pd-x', domain: 'ghost.test' }]);
    const { db } = await import('../db');
    vi.mocked(db.execute).mockRejectedValueOnce(new Error('connection terminated'));
    await expect(runDailyMaintenance(new Date('2026-09-17T12:00:00Z'))).rejects.toThrow(/connection terminated/);
    expect(probeRecord).not.toHaveBeenCalledWith('send_only');
  });

  it('re-checks every live static row so a delisted domain stops being used', async () => {
    providerMock.verifiesByDns = false;
    execRows.push([{ id: 'd1' }, { id: 'd2' }]);
    const result = await runDailyMaintenance(new Date('2026-09-17T12:00:00Z'));
    expect(result.rechecked).toBe(2);
    expect(queueAdd).toHaveBeenCalledTimes(2);
  });
});

describe('evaluate-auto-suspend', () => {
  it('collapses a burst for one partner into ONE job by using the partner id as jobId', async () => {
    laneConfigured.value = true;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd).toHaveBeenCalledWith(
      'evaluate-auto-suspend',
      { partnerId: PARTNER_ID },
      expect.objectContaining({ jobId: `autosuspend:${PARTNER_ID}` }),
    );
  });

  it('does not enqueue on an instance with no partner lane configured', async () => {
    laneConfigured.value = false;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('the worker processor routes the job to evaluateAutoSuspension', async () => {
    laneConfigured.value = true;
    await initializeSendingDomainsWorker();
    const processor = workerCtor.mock.calls[0]![1] as (job: { name: string; data: unknown }) => Promise<unknown>;
    await processor({ name: 'evaluate-auto-suspend', data: { partnerId: PARTNER_ID } });
    expect(evaluateAutoSuspendMock).toHaveBeenCalledWith(PARTNER_ID);
  });

  // The evaluation makes no provider call, so a retry storm cannot burn the
  // account's 10 req/s budget — but a failure should still be retried a couple
  // of times rather than dropped, since it ends in a kill-switch decision.
  it('is enqueued with bounded retries', async () => {
    laneConfigured.value = true;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd.mock.calls[0]![2]).toMatchObject({ attempts: 3 });
  });

  // BullMQ refuses a later add() whose jobId still matches a RETAINED record,
  // so keeping completed/failed jobs would silently drop every subsequent
  // evaluation for that partner — the collapse-the-burst design turned into a
  // permanent mute.
  it('retains no job record, so a later evaluation for the same partner is not dropped', async () => {
    laneConfigured.value = true;
    await enqueueAutoSuspendEvaluation(PARTNER_ID);
    expect(queueAdd.mock.calls[0]![2]).toMatchObject({
      removeOnComplete: true,
      removeOnFail: true,
    });
  });
});
