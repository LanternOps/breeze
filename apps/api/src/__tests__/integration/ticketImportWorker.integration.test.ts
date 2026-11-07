/**
 * The ticket import worker with the fake module (#8313 W4; spec
 * docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md
 * §5.8–§5.10, §8 W4 row) against real Postgres (as breeze_app) and Redis:
 * the real lease, ledger, writer and window. S3 is faked at its lowest
 * boundary, as in ticketImportAttachments.integration.test.ts.
 *
 * Proves: a slice continues itself; a retried slice whose successor already
 * ran exits on slice_seq; a crash mid-page resumes from the ledger; a closed
 * window stops the run; a 429 defers without spending an attempt (a real
 * BullMQ worker); the deletions probe; merged_in_breeze and
 * removed_in_breeze are final across passes; a W1 transient attachment
 * failure is retried by the next run; MIGRATION_SOURCE_ID_IN_USE fails the
 * item with its reason and the run continues; the dry run writes nothing.
 */
import './setup';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

const s3 = vi.hoisted(() => ({ configured: true, objects: new Map<string, Buffer>() }));
const refLookups = vi.hoisted(() => ({ calls: [] as Array<{ principalId: string; keys: string[] }> }));

vi.mock('../../services/s3Storage', async (orig) => ({
  ...(await orig<typeof import('../../services/s3Storage')>()),
  isS3Configured: () => s3.configured,
  putObjectBuffer: async (key: string, body: Buffer) => { s3.objects.set(key, Buffer.from(body)); },
  deleteObjects: async (keys: readonly string[]) => { for (const key of keys) s3.objects.delete(key); },
}));
vi.mock('../../services/ticketImport/conversionLookups', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketImport/conversionLookups')>();
  return {
    ...actual,
    keysWithRef: async (principalId: string, keys: readonly string[]) => {
      refLookups.calls.push({ principalId, keys: [...keys] });
      return actual.keysWithRef(principalId, keys);
    },
  };
});
vi.mock('../../services/ticketEvents', async (orig) => {
  const actual = await orig<typeof import('../../services/ticketEvents')>();
  const record = async () => undefined;
  return { ...actual, emitTicketEvent: record, enqueueTicketEvent: record };
});

import { Queue, QueueEvents, Worker, type Job } from 'bullmq';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import {
  migrationWindows,
  ticketAttachments,
  ticketComments,
  ticketExternalRefs,
  ticketImportItems,
  ticketImportRunIssues,
  tickets,
} from '../../db/schema';
import { handleTicketImportJobFailed, processTicketImportJob, processTicketImportSlice, runStalledRunSweep } from '../../jobs/ticketImportWorker';
import { MigrationWindowError } from '../../services/migrationWindows';
import { getBullMQConnection } from '../../services/redis';
import { ticketImportLimits } from '../../services/ticketImport/importLimits';
import { runSlice } from '../../services/ticketImport/importRunner';
import { importTicket } from '../../services/ticketImport/importWriter';
import { registerTicketImportModule } from '../../services/ticketImport/moduleRegistry';
import { claimSlice, commitSlice, runContext } from '../../services/ticketImport/runLedger';
import { normalizeCounters } from '../../services/ticketImport/runReport';
import { SourceAuthError, SourceUnavailableError } from '../../services/ticketImport/sourceFetch';
import { clearFakeSources, fakeTicketImportModule } from '../../services/ticketImport/testing/fakeModule';
import { upsertTicketExternalRef } from '../../services/ticketExternalRefs';
import { mergeTickets } from '../../services/ticketMerge';
import { createTicket } from '../../services/ticketService';
import {
  closeWindow,
  drive,
  fakeTickets,
  ledger,
  minutes,
  openWindow,
  runRow,
  seedImport,
  setMappings,
  sliceJob,
  startImportRun,
  type ImportFx,
} from './ticketImportFixtures';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const CASE_TIMEOUT = 120_000;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

/** One ticket per slice: the budget is spent after the first unit of work. */
const oneTicketPerSlice = { sliceDeps: { limits: { ...ticketImportLimits(), sliceMs: 1 } } };

let unregister: () => void;
beforeAll(() => { unregister = registerTicketImportModule(fakeTicketImportModule); });
afterAll(() => unregister());
beforeEach(() => { s3.configured = true; s3.objects.clear(); });
afterEach(() => clearFakeSources());

async function importedTickets(fx: ImportFx) {
  return getTestDb()
    .select({ id: tickets.id, orgId: tickets.orgId, deletedAt: tickets.deletedAt, key: ticketExternalRefs.externalId, assignedTo: tickets.assignedTo })
    .from(tickets)
    .innerJoin(ticketExternalRefs, eq(ticketExternalRefs.ticketId, tickets.id))
    .where(eq(ticketExternalRefs.partnerServicePrincipalId, fx.principal.id));
}

async function issuesOf(runId: string) {
  return getTestDb().select().from(ticketImportRunIssues).where(eq(ticketImportRunIssues.runId, runId));
}

describe('ticket import worker (fake module, real Postgres and Redis)', () => {
  runDb('imports a source in self-continuing slices and reports it', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['t1', 't2', 't3', 't4', 't5']);
    fx.source.tickets[0]!.ownerEmail = fx.agent.email;
    fx.source.tickets[1]!.ownerEmail = 'gone@former.example';
    fx.source.tickets[2]!.ownerEmail = 'gone@former.example';
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);

    const steps = await drive(fx, run.id, { deps: oneTicketPerSlice });
    expect(steps.filter((s) => s.outcome === 'continue').length).toBeGreaterThanOrEqual(5);
    expect(steps.at(-1)).toMatchObject({ outcome: 'finished' });
    // Each slice ran under its own seq, in order.
    expect(steps.map((s) => s.seq)).toEqual(steps.map((_, i) => i));

    const row = await runRow(run.id);
    expect(row).toMatchObject({ state: 'completed', phase: 'done', stopReason: null });
    expect(row.sliceSeq).toBe(steps.length - 1);
    const counters = normalizeCounters(row.counters);
    expect(counters.tickets).toMatchObject({ seen: 5, created: 5, resumed: 0, failed: 0 });
    expect(counters.comments.written).toBe(5);
    expect(counters.ownersUnmatched).toBe(1);

    const imported = await importedTickets(fx);
    expect(imported.map((t) => t.key).sort()).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(imported.find((t) => t.key === 't1')!.assignedTo).toBe(fx.agent.id);
    const items = await ledger(fx.sourceId);
    expect([...items.values()].every((i) => i.state === 'imported' && i.importedVersion === 'v1' && i.seenRunId === run.id)).toBe(true);
    // The unmatched owner is listed once, with the source user key as code,
    // although t2 and t3 were imported by different slices (review #13).
    const owners = (await issuesOf(run.id)).filter((i) => i.kind === 'owner_unmatched');
    expect(owners.map((i) => i.code)).toEqual(['gone@former.example']);
    // The cursor holds positions and counts only.
    expect(Object.keys(row.cursor).sort()).toEqual(['clockSkewMs', 'deletions', 'links', 'scan', 'sourceFailures']);

    // A second pass over an unchanged source loads nothing.
    fx.source.calls.load = [];
    const again = await startImportRun(fx, 'import', window.id);
    await drive(fx, again.id);
    expect(fx.source.calls.load).toEqual([]);
    expect(normalizeCounters((await runRow(again.id)).counters).tickets).toMatchObject({ seen: 5, unchanged: 5, created: 0 });
  }, CASE_TIMEOUT);

  runDb('a retried slice whose successor already ran exits on slice_seq and writes nothing', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['a', 'b', 'c']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    const enqueued: number[] = [];
    const enqueue = async (data: { seq: number }) => { enqueued.push(data.seq); };
    const first = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }), 'tok', { ...oneTicketPerSlice, enqueue });
    expect(first).toEqual({ kind: 'continue' });
    const after = await runRow(run.id);
    expect(after.sliceSeq).toBe(1);

    // BullMQ retries slice 0 (say its completion was lost): it finds the run
    // handed over, re-enqueues the successor (a no-op when it exists) and exits.
    const retried = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }, 1), 'tok', { ...oneTicketPerSlice, enqueue });
    expect(retried).toEqual({ kind: 'superseded', sliceSeq: 1, active: true });
    expect(enqueued).toEqual([1, 1]);
    const unchanged = await runRow(run.id);
    expect(unchanged.cursor).toEqual(after.cursor);
    expect(unchanged.counters).toEqual(after.counters);
    expect(fx.source.calls.load).toEqual(['a']);

    await drive(fx, run.id, { startSeq: 1 });
    expect((await runRow(run.id)).state).toBe('completed');
    expect((await importedTickets(fx)).length).toBe(3);
  }, CASE_TIMEOUT);

  runDb('a crash mid-page resumes from the ledger: no ticket is imported twice', async () => {
    const fx = await seedImport();
    fx.source.pageSize = 4;
    fx.source.tickets = fakeTickets(['p1', 'p2', 'p3', 'p4']);
    // The database connection drops while p3 is written: an infrastructure
    // fault, which ends the slice (a ticket's own error would not).
    let dropped = false;
    const flaky: typeof importTicket = async (windowId, ticket, options) => {
      if (ticket.sourceId === 'p3' && !dropped) {
        dropped = true;
        throw Object.assign(new Error('Connection terminated unexpectedly'), { code: 'CONNECTION_CLOSED' });
      }
      return importTicket(windowId, ticket, options);
    };
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    const steps = await drive(fx, run.id, { deps: { sliceDeps: { importTicket: flaky } } });
    expect(steps.map((s) => s.outcome)).toEqual(['retried', 'finished']);
    // The page was read again, and only p3 onwards loaded again.
    expect(fx.source.calls.scan).toBe(2);
    expect(fx.source.calls.load).toEqual(['p1', 'p2', 'p3', 'p3', 'p4']);
    const imported = await importedTickets(fx);
    expect(imported.map((t) => t.key).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    const comments = await getTestDb().select({ id: ticketComments.id }).from(ticketComments)
      .where(and(inArray(ticketComments.ticketId, imported.map((t) => t.id)), isNotNull(ticketComments.importSourceId)));
    expect(comments.length).toBe(4);
    expect(normalizeCounters((await runRow(run.id)).counters).tickets).toMatchObject({ seen: 4, created: 4 });
  }, CASE_TIMEOUT);

  runDb('one bad ticket never ends the run: module bugs, writer errors and id violations fail only their ticket', async () => {
    const fx = await seedImport();
    fx.source.pageSize = 5;
    fx.source.tickets = [
      ...fakeTickets(['b1', 'b2', 'b3', 'b4']),
      ...fakeTickets(['b5'], { wrongSourceId: true }),
    ];
    // b1: the module's load throws a TypeError (a module bug).
    fx.source.failures.load.set('b1', [new TypeError("Cannot read properties of undefined (reading 'id')")]);
    // b2: the writer throws something nothing maps.
    const broken: typeof importTicket = async (windowId, ticket, options) => {
      if (ticket.sourceId === 'b2') throw new RangeError('Invalid time value');
      return importTicket(windowId, ticket, options);
    };
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    const steps = await drive(fx, run.id, { deps: { sliceDeps: { importTicket: broken } } });
    expect(steps.map((s) => s.outcome)).toEqual(['finished']);
    expect(await runRow(run.id)).toMatchObject({ state: 'completed' });
    const items = await ledger(fx.sourceId);
    expect(items.get('b1')).toMatchObject({ state: 'failed', failureCode: 'internal_error', attempts: 1 });
    expect(items.get('b2')).toMatchObject({ state: 'failed', failureCode: 'internal_error' });
    // b5's conversion names another ticket: refused visibly, nothing written under either key.
    expect(items.get('b5')).toMatchObject({ state: 'failed', failureCode: 'module_contract_violation' });
    expect(items.get('b3')).toMatchObject({ state: 'imported' });
    expect(items.get('b4')).toMatchObject({ state: 'imported' });
    expect((await importedTickets(fx)).map((t) => t.key).sort()).toEqual(['b3', 'b4']);
    expect(normalizeCounters((await runRow(run.id)).counters).tickets).toMatchObject({ seen: 5, created: 2, failed: 3 });
  }, CASE_TIMEOUT);

  runDb('a closed window stops the run; a later run resumes from the ledger', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['w1', 'w2', 'w3']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    const first = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }), 'tok', { ...oneTicketPerSlice, enqueue: async () => undefined });
    expect(first.kind).toBe('continue');
    await closeWindow(fx, window.id);
    const second = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 1 }), 'tok', { enqueue: async () => undefined });
    expect(second).toEqual({ kind: 'finished', state: 'stopped', stopReason: 'window_closed' });
    expect(await runRow(run.id)).toMatchObject({ state: 'stopped', stopReason: 'window_closed' });
    expect((await importedTickets(fx)).map((t) => t.key)).toEqual(['w1']);

    const next = await openWindow(fx);
    const resumed = await startImportRun(fx, 'import', next.id);
    await drive(fx, resumed.id);
    expect(normalizeCounters((await runRow(resumed.id)).counters).tickets).toMatchObject({ unchanged: 1, created: 2 });
    expect((await importedTickets(fx)).length).toBe(3);
  }, CASE_TIMEOUT);

  runDb('a 429 from the window defers the slice without touching the ledger', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['r1']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    let calls = 0;
    const throttled: typeof importTicket = async (...args) => {
      calls += 1;
      if (calls === 1) {
        throw new MigrationWindowError('MIGRATION_WINDOW_RATE_LIMITED', 'bytes', 429, { kind: 'bytes', retryAfterSeconds: 7 });
      }
      return importTicket(...args);
    };
    const job = sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 });
    const moved = vi.spyOn(job, 'moveToDelayed');
    const before = Date.now();
    await expect(processTicketImportSlice(job, 'tok', { sliceDeps: { importTicket: throttled }, enqueue: async () => undefined }))
      .rejects.toMatchObject({ name: 'DelayedError' });
    expect(moved).toHaveBeenCalledTimes(1);
    expect(moved.mock.calls[0]![0]).toBeGreaterThanOrEqual(before + 7_000);
    expect(moved.mock.calls[0]![1]).toBe('tok');
    expect((await ledger(fx.sourceId)).size).toBe(0);
    expect(await runRow(run.id)).toMatchObject({ state: 'running', sliceSeq: 0 });

    await drive(fx, run.id, { deps: { sliceDeps: { importTicket: throttled } } });
    expect((await ledger(fx.sourceId)).get('r1')).toMatchObject({ state: 'imported' });
  }, CASE_TIMEOUT);

  runDb('a deferred slice spends no BullMQ attempt (real queue and worker)', async () => {
    const queueName = `ticket-import-defer-test-${Date.now()}`;
    const queue = new Queue(queueName, { connection: getBullMQConnection() });
    const events = new QueueEvents(queueName, { connection: getBullMQConnection() });
    await events.waitUntilReady();
    let runs = 0;
    const worker = new Worker(queueName, (job: Job, token?: string) => processTicketImportSlice(job, token, {
      acquireLease: async () => ({ token: 't', partnerId: 'p', held: () => true, release: async () => undefined }),
      runSlice: async () => {
        runs += 1;
        return runs === 1
          ? { kind: 'defer', delayMs: 1_000, reason: 'window_rate_limited' }
          : { kind: 'finished', state: 'completed', stopReason: null };
      },
      enqueue: async () => undefined,
    }), { connection: getBullMQConnection() });
    try {
      const job = await queue.add('slice', { runId: crypto.randomUUID(), partnerId: crypto.randomUUID(), seq: 0 }, { attempts: 1 });
      await job.waitUntilFinished(events, 15_000);
      const done = await queue.getJob(job.id!);
      expect(runs).toBe(2);
      // attempts: 1 and it still completed: the deferral was not an attempt.
      expect(done!.attemptsMade).toBe(1);
      expect(await done!.getState()).toBe('completed');
    } finally {
      await worker.close();
      await events.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  }, CASE_TIMEOUT);

  runDb('the deletions phase probes unseen tickets: deleted and hidden are reported, a shifted one is imported', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['d1', 'd2', 'd3', 'd4']);
    const window = await openWindow(fx);
    await drive(fx, (await startImportRun(fx, 'import', window.id)).id);

    fx.source.deleted.add('d1');
    fx.source.hidden.add('d2');
    fx.source.shifted.add('d3');
    const d3 = fx.source.tickets.find((t) => t.key === 'd3')!;
    d3.version = 'v2';
    d3.comments = [...d3.comments!, { id: 'd3-2', at: minutes(50), content: 'Added after the bulk pass' }];
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);

    expect([...fx.source.calls.probe].sort()).toEqual(['d1', 'd2', 'd3']);
    const counters = normalizeCounters((await runRow(run.id)).counters);
    expect(counters).toMatchObject({ deletedInSource: 1, hiddenInSource: 1 });
    expect(counters.tickets).toMatchObject({ unchanged: 1, resumed: 1 });
    const items = await ledger(fx.sourceId);
    expect(items.get('d1')).toMatchObject({ state: 'deleted_in_source', seenRunId: run.id });
    expect(items.get('d2')).toMatchObject({ state: 'hidden_in_source', seenRunId: run.id });
    expect(items.get('d3')).toMatchObject({ state: 'imported', importedVersion: 'v2' });
    expect((await issuesOf(run.id)).map((i) => `${i.kind}:${i.sourceTicketKey}`).sort())
      .toEqual(['deleted_in_source:d1', 'hidden_in_source:d2']);
    // Nothing is ever deleted in Breeze.
    expect((await importedTickets(fx)).filter((t) => t.deletedAt === null).length).toBe(4);
  }, CASE_TIMEOUT);

  runDb('a probe the source cannot answer now leaves the ticket imported and is retried by the next run (review #5)', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['q1', 'q2']);
    const window = await openWindow(fx);
    const first = await startImportRun(fx, 'import', window.id);
    await drive(fx, first.id);

    fx.source.shifted.add('q1');
    fx.source.failures.probe.set('q1', [new SourceUnavailableError('gateway timeout')]);
    const second = await startImportRun(fx, 'import', window.id);
    await drive(fx, second.id);
    expect(await runRow(second.id)).toMatchObject({ state: 'completed' });
    expect((await ledger(fx.sourceId)).get('q1')).toMatchObject({ state: 'imported', seenRunId: first.id });
    expect(normalizeCounters((await runRow(second.id)).counters).tickets.failed).toBe(0);
    expect((await issuesOf(second.id)).map((i) => [i.kind, i.sourceTicketKey, i.code])).toEqual([['probe_deferred', 'q1', 'source_unavailable']]);

    // The next run probes it again; this time the source answers.
    const third = await startImportRun(fx, 'import', window.id);
    await drive(fx, third.id);
    expect(fx.source.calls.probe.filter((k) => k === 'q1')).toHaveLength(2);
    expect((await ledger(fx.sourceId)).get('q1')).toMatchObject({ state: 'imported', seenRunId: third.id });
  }, CASE_TIMEOUT);

  runDb('a source that answers Retry-After forever stops the run after 20 waits; a success resets the count (review #6)', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['ra']);
    fx.source.failures.scan = Array.from({ length: 25 }, () => new SourceUnavailableError('slow down', 5_000));
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    const steps = await drive(fx, run.id);
    expect(steps.filter((s) => s.outcome === 'delayed')).toHaveLength(19);
    expect(await runRow(run.id)).toMatchObject({ state: 'stopped', stopReason: 'source_unavailable' });

    const fx2 = await seedImport();
    fx2.source.tickets = fakeTickets(['rb']);
    fx2.source.failures.scan = Array.from({ length: 3 }, () => new SourceUnavailableError('slow down', 5_000));
    const window2 = await openWindow(fx2);
    const run2 = await startImportRun(fx2, 'import', window2.id);
    const steps2 = await drive(fx2, run2.id);
    expect(steps2.filter((s) => s.outcome === 'delayed')).toHaveLength(3);
    const done = await runRow(run2.id);
    expect(done.state).toBe('completed');
    expect((done.cursor as { sourceFailures: number }).sourceFailures).toBe(0);
  }, CASE_TIMEOUT);

  runDb('a refused credential on a file stops the run; a file Retry-After defers the slice and the ticket resumes (review #7)', async () => {
    const fx = await seedImport();
    const withFile = (key: string) => fakeTickets([key], {
      comments: [{ id: `${key}-1`, at: minutes(5), content: 'File', files: [{ id: `${key}f`, filename: 'a.png', bytes: new Uint8Array(PNG), declaredBytes: PNG.length }] }],
    });
    fx.source.tickets = withFile('u1');
    fx.source.failures.file.set('file:u1f', [new SourceAuthError()]);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    expect(await runRow(run.id)).toMatchObject({ state: 'stopped', stopReason: 'source_unauthorized' });
    const [begun] = await importedTickets(fx);
    expect((await ledger(fx.sourceId)).get('u1')).toMatchObject({ state: 'failed', failureCode: 'incomplete', breezeTicketId: begun!.id });

    const fx2 = await seedImport();
    fx2.source.tickets = withFile('u2');
    fx2.source.failures.file.set('file:u2f', [new SourceUnavailableError('wait', 30_000)]);
    const window2 = await openWindow(fx2);
    const run2 = await startImportRun(fx2, 'import', window2.id);
    const steps = await drive(fx2, run2.id);
    expect(steps.map((s) => s.outcome)).toEqual(['delayed', 'finished']);
    expect(await runRow(run2.id)).toMatchObject({ state: 'completed' });
    expect((await ledger(fx2.sourceId)).get('u2')).toMatchObject({ state: 'imported' });
    expect(normalizeCounters((await runRow(run2.id)).counters)).toMatchObject({ tickets: { failed: 0, resumed: 1 }, attachments: { written: 1 } });
  }, CASE_TIMEOUT);

  runDb('a key listed twice in one page is processed once, and the ledger commit keeps one row per key (review #8)', async () => {
    const fx = await seedImport();
    fx.source.pageSize = 4;
    const [dup, other] = fakeTickets(['dup', 'other']);
    fx.source.tickets = [dup!, other!, dup!];
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    expect(await runRow(run.id)).toMatchObject({ state: 'completed' });
    expect(fx.source.calls.load.sort()).toEqual(['dup', 'other']);
    expect(normalizeCounters((await runRow(run.id)).counters).tickets).toMatchObject({ seen: 2, created: 2 });
    expect([...(await ledger(fx.sourceId)).keys()].sort()).toEqual(['dup', 'other']);

    // Two writes of one key in one commit: the last one wins, no conflict error.
    const next = await startImportRun(fx, 'dry_run');
    const ctx = runContext(fx.partner.id);
    const token = await withDbAccessContext(ctx, () => claimSlice(fx.partner.id, next.id, 0));
    expect(token).not.toBeNull();
    const base = { importedVersion: null, seenVersion: 'v9', seenRunId: next.id, breezeTicketId: null, pendingLinks: null, failureCode: null, attempts: 0 };
    await withDbAccessContext(ctx, () => commitSlice(fx.partner.id, next.id, 0, token!, {
      sourceId: fx.sourceId, phase: 'scan', cursor: {}, counters: {},
      items: [{ ...base, sourceTicketKey: 'dup', state: 'failed' }, { ...base, sourceTicketKey: 'dup', state: 'skipped' }],
    }));
    expect((await ledger(fx.sourceId)).get('dup')).toMatchObject({ state: 'skipped', seenVersion: 'v9' });
  }, CASE_TIMEOUT);

  runDb('a successor that cannot be enqueued fails the run instead of leaving it running (review #9a)', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['e1', 'e2']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    let attempts = 0;
    const out = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }), 'tok', {
      ...oneTicketPerSlice,
      enqueueRetryDelaysMs: [1, 1],
      enqueue: async () => { attempts += 1; throw new Error('Redis unavailable'); },
    });
    expect(attempts).toBe(3);
    expect(out).toEqual({ kind: 'finished', state: 'failed', stopReason: 'worker_error' });
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', stopReason: 'worker_error' });
    // The source is free for a new run, which resumes from the ledger.
    const next = await startImportRun(fx, 'import', window.id);
    await drive(fx, next.id);
    expect(normalizeCounters((await runRow(next.id)).counters).tickets).toMatchObject({ unchanged: 1, created: 1 });
  }, CASE_TIMEOUT);

  runDb('the stalled-run sweep fails a run with no sign of life, and leaves deferred and live ones alone (review #9b)', async () => {
    const stale = await seedImport();
    const deferred = await seedImport();
    const live = await seedImport();
    const staleRun = await startImportRun(stale, 'dry_run');
    const deferredRun = await startImportRun(deferred, 'dry_run');
    const liveRun = await startImportRun(live, 'dry_run');
    const hoursAgo = sql`now() - interval '2 hours'`;
    await getTestDb().execute(sql`UPDATE ticket_import_runs SET state = 'running', started_at = ${hoursAgo}, heartbeat_at = ${hoursAgo} WHERE id = ${staleRun.id}`);
    // Deferred for a long 429: its heartbeat is old, but it is due back later.
    await getTestDb().execute(sql`UPDATE ticket_import_runs SET state = 'running', started_at = ${hoursAgo}, heartbeat_at = ${hoursAgo}, resume_at = now() + interval '10 minutes' WHERE id = ${deferredRun.id}`);

    const out = await processTicketImportJob({ name: 'stalled-run-sweep', data: {}, opts: {} } as unknown as Job, 'tok');
    expect(out).toEqual({ failed: 1 });
    expect(await runRow(staleRun.id)).toMatchObject({ state: 'failed', stopReason: 'worker_lost' });
    expect((await runRow(deferredRun.id)).state).toBe('running');
    expect((await runRow(liveRun.id)).state).toBe('queued');
    expect(await runStalledRunSweep()).toEqual({ failed: 0 });
    // The swept source can run again.
    await expect(startImportRun(stale, 'dry_run')).resolves.toMatchObject({ state: 'queued' });
  }, CASE_TIMEOUT);

  runDb('BullMQ\'s failed event fails the run of a slice that exhausted its attempts (review #9c)', async () => {
    const fx = await seedImport();
    const run = await startImportRun(fx, 'dry_run');
    const data = { runId: run.id, partnerId: fx.partner.id, seq: 0 };
    expect(await handleTicketImportJobFailed(sliceJob(data, 1), new Error('stalled'))).toBe(false);
    expect((await runRow(run.id)).state).toBe('queued');
    expect(await handleTicketImportJobFailed(sliceJob(data, 3), new Error('job stalled more than allowable limit'))).toBe(true);
    expect(await runRow(run.id)).toMatchObject({ state: 'failed', stopReason: 'worker_error' });
  }, CASE_TIMEOUT);

  runDb('a slice waiting on a busy lease records when it is due back', async () => {
    const fx = await seedImport();
    const run = await startImportRun(fx, 'dry_run');
    const job = sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 });
    await expect(processTicketImportSlice(job, 'tok', { acquireLease: async () => null })).rejects.toMatchObject({ name: 'DelayedError' });
    const row = await runRow(run.id);
    expect(row.heartbeatAt).not.toBeNull();
    expect(row.resumeAt!.getTime()).toBeGreaterThan(Date.now());
  }, CASE_TIMEOUT);

  runDb('a duplicate execution of one seq fails its claim token and writes nothing (review #10)', async () => {
    const fx = await seedImport();
    const run = await startImportRun(fx, 'dry_run');
    const ctx = runContext(fx.partner.id);
    const first = await withDbAccessContext(ctx, () => claimSlice(fx.partner.id, run.id, 0));
    const second = await withDbAccessContext(ctx, () => claimSlice(fx.partner.id, run.id, 0));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    const commit = { sourceId: fx.sourceId, phase: 'scan' as const, cursor: { marker: 'x' }, counters: {} };
    await expect(withDbAccessContext(ctx, () => commitSlice(fx.partner.id, run.id, 0, first!, commit)))
      .rejects.toMatchObject({ name: 'SliceSupersededError' });
    expect((await runRow(run.id)).cursor).toEqual({});
    await withDbAccessContext(ctx, () => commitSlice(fx.partner.id, run.id, 0, second!, commit));
    expect((await runRow(run.id)).cursor).toEqual({ marker: 'x' });

    // Two executions of slice 0 at once (no lease between them): exactly one
    // goes on, and every ticket is imported once.
    const fx2 = await seedImport();
    fx2.source.tickets = fakeTickets(['x1', 'x2', 'x3']);
    const window = await openWindow(fx2);
    const run2 = await startImportRun(fx2, 'import', window.id);
    const input = { runId: run2.id, partnerId: fx2.partner.id, seq: 0 };
    const outcomes = await Promise.all([runSlice(input), runSlice(input)]);
    expect(outcomes.filter((o) => o.kind === 'superseded')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind !== 'superseded')).toHaveLength(1);
    // No ticket twice. A ticket both wrote at the same moment is refused to
    // the later writer (held_elsewhere), so the winner may count it failed;
    // the next run resumes it.
    const keys = (await importedTickets(fx2)).map((t) => t.key).sort();
    expect(keys).toEqual(['x1', 'x2', 'x3']);
    const t = normalizeCounters((await runRow(run2.id)).counters).tickets;
    expect(t.seen).toBe(3);
    expect(t.created + t.resumed + t.failed).toBe(3);
  }, CASE_TIMEOUT);

  runDb('links wait on their items for the links phase, never in the cursor (review #13)', async () => {
    const fx = await seedImport();
    const at = minutes(40);
    fx.source.tickets = [
      ...fakeTickets(['m1'], { links: [{ targetKey: 'sv', linkType: 'duplicate_of', at }] }),
      ...fakeTickets(['m2'], { links: [{ targetKey: 'gone', linkType: 'duplicate_of', at }] }),
      ...fakeTickets(['sv']),
    ];
    const written: string[] = [];
    const linkWriter = {
      async writeLink(_windowId: string, link: { sourceKey: string; targetKey: string }) {
        written.push(`${link.sourceKey}->${link.targetKey}`);
        // The survivor of m2 was never imported: worth another try next pass.
        return link.targetKey === 'gone' ? { outcome: 'not_written' as const, code: 'target_missing', retry: true } : { outcome: 'written' as const };
      },
    };
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id, { deps: { ...oneTicketPerSlice, sliceDeps: { ...oneTicketPerSlice.sliceDeps, linkWriter } } });
    expect(await runRow(run.id)).toMatchObject({ state: 'completed' });
    expect(written.sort()).toEqual(['m1->sv', 'm2->gone']);
    const items = await ledger(fx.sourceId);
    // m1: its link is written, so its version is complete; m2 is reloaded next pass.
    expect(items.get('m1')).toMatchObject({ state: 'imported', importedVersion: 'v1', pendingLinks: null });
    expect(items.get('m2')).toMatchObject({ state: 'imported', importedVersion: null, pendingLinks: null });
    expect(normalizeCounters((await runRow(run.id)).counters)).toMatchObject({ linksWritten: 1, linksAsNotes: 1 });
    expect((await issuesOf(run.id)).filter((i) => i.kind === 'link_not_written').map((i) => [i.sourceTicketKey, i.code])).toEqual([['m2', 'target_missing']]);
    expect(JSON.stringify((await runRow(run.id)).cursor)).not.toContain('sv');
  }, CASE_TIMEOUT);

  runDb('merged_in_breeze and removed_in_breeze are final across passes', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['m', 'r', 's']);
    const bulk = await openWindow(fx);
    await drive(fx, (await startImportRun(fx, 'import', bulk.id)).id);
    const byKey = new Map((await importedTickets(fx)).map((t) => [t.key, t.id]));
    // Breeze refuses to merge a ticket of an open import: the window closes first.
    await closeWindow(fx, bulk.id);

    // In Breeze: a technician merges m into s and hard-deletes r.
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    await withDbAccessContext(fx.ownerContext(), () => mergeTickets({ sourceTicketId: byKey.get('m')!, intoTicketId: byKey.get('s')!, notifyRequester: false }, tech));
    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, byKey.get('r')!)));
    const window = await openWindow(fx);

    // Both change in the source.
    for (const t of fx.source.tickets) t.version = 'v2';
    const second = await startImportRun(fx, 'import', window.id);
    fx.source.calls.load = [];
    await drive(fx, second.id);
    // r is decided from the ledger and the refs, without loading it.
    expect(fx.source.calls.load.sort()).toEqual(['m', 's']);
    let items = await ledger(fx.sourceId);
    expect(items.get('m')).toMatchObject({ state: 'merged_in_breeze' });
    expect(items.get('r')).toMatchObject({ state: 'removed_in_breeze' });
    const issues = await issuesOf(second.id);
    expect(issues.find((i) => i.kind === 'merged_in_breeze')).toMatchObject({ sourceTicketKey: 'm', code: byKey.get('s') });
    expect(issues.find((i) => i.kind === 'removed_in_breeze')).toMatchObject({ sourceTicketKey: 'r' });

    // A third pass, newer again: both stay final, neither is loaded, r is never recreated.
    for (const t of fx.source.tickets) t.version = 'v3';
    fx.source.calls.load = [];
    const third = await startImportRun(fx, 'import', window.id);
    await drive(fx, third.id);
    expect(fx.source.calls.load).toEqual(['s']);
    items = await ledger(fx.sourceId);
    expect(items.get('m')!.state).toBe('merged_in_breeze');
    expect(items.get('r')!.state).toBe('removed_in_breeze');
    expect((await importedTickets(fx)).map((t) => t.key).sort()).toEqual(['m', 's']);
  }, CASE_TIMEOUT);

  runDb('a transient attachment failure (W1) fails the ticket for this run; the next run imports it', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['f1'], {
      comments: [{ id: 'f1-1', at: minutes(5), content: 'Screenshot attached', files: [{ id: 'img', filename: 'screen.png', bytes: new Uint8Array(PNG), declaredBytes: PNG.length }] }],
    });
    fx.source.failures.file.set('file:img', [new SourceUnavailableError('timeout')]);
    const window = await openWindow(fx);
    const first = await startImportRun(fx, 'import', window.id);
    await drive(fx, first.id);
    expect(await runRow(first.id)).toMatchObject({ state: 'completed' });
    expect((await ledger(fx.sourceId)).get('f1')).toMatchObject({ state: 'failed', failureCode: 'attachment_unavailable', attempts: 1 });
    expect((await issuesOf(first.id)).map((i) => [i.kind, i.code])).toContainEqual(['failed', 'attachment_unavailable']);

    const second = await startImportRun(fx, 'import', window.id);
    await drive(fx, second.id);
    const [ticket] = await importedTickets(fx);
    expect((await ledger(fx.sourceId)).get('f1')).toMatchObject({ state: 'imported', failureCode: null, attempts: 0, breezeTicketId: ticket!.id });
    const files = await getTestDb().select().from(ticketAttachments).where(eq(ticketAttachments.ticketId, ticket!.id));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ importSourceId: 'file:img', contentType: 'image/png' });
    expect(files[0]!.commentId).not.toBeNull();
    expect(normalizeCounters((await runRow(second.id)).counters).attachments).toMatchObject({ written: 1, bytes: PNG.length });
  }, CASE_TIMEOUT);

  runDb('a ticket begun and then failed is never recreated once a technician deletes it (review #2)', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['h1'], {
      comments: [{ id: 'h1-1', at: minutes(5), content: 'With a file', files: [{ id: 'h1f', filename: 'a.png', bytes: new Uint8Array(PNG), declaredBytes: PNG.length }] }],
    });
    // The header commits, then the file fails transiently (W1's 503).
    fx.source.failures.file.set('file:h1f', [new SourceUnavailableError('timeout')]);
    const window = await openWindow(fx);
    await drive(fx, (await startImportRun(fx, 'import', window.id)).id);
    const [begun] = await importedTickets(fx);
    expect(begun).toBeDefined();
    expect((await ledger(fx.sourceId)).get('h1')).toMatchObject({ state: 'failed', failureCode: 'attachment_unavailable', breezeTicketId: begun!.id, importedVersion: null });

    // A technician hard-deletes the partial ticket; the next run must not recreate it.
    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, begun!.id)));
    fx.source.calls.load = [];
    const next = await startImportRun(fx, 'import', window.id);
    await drive(fx, next.id);
    expect(fx.source.calls.load).toEqual([]);
    expect((await ledger(fx.sourceId)).get('h1')).toMatchObject({ state: 'removed_in_breeze', breezeTicketId: begun!.id });
    expect(await importedTickets(fx)).toEqual([]);
    expect((await issuesOf(next.id)).map((i) => i.kind)).toEqual(['removed_in_breeze']);
  }, CASE_TIMEOUT);

  runDb('a run that stops mid-ticket records the ticket it began before stopping (review #2)', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['s1'], {
      comments: [{ id: 's1-1', at: minutes(5), content: 'With a file', files: [{ id: 's1f', filename: 'a.png', bytes: new Uint8Array(PNG), declaredBytes: PNG.length }] }],
    });
    const window = await openWindow(fx);
    // The window closes while the file downloads: after the header committed.
    const closing: typeof importTicket = (windowId, ticket, options) => importTicket(windowId, ticket, {
      ...options,
      fetchAttachment: async (id, max) => {
        await closeWindow(fx, windowId);
        return options.fetchAttachment!(id, max);
      },
    });
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id, { deps: { sliceDeps: { importTicket: closing } } });
    expect(await runRow(run.id)).toMatchObject({ state: 'stopped', stopReason: 'window_closed' });
    const [begun] = await importedTickets(fx);
    expect((await ledger(fx.sourceId)).get('s1')).toMatchObject({ breezeTicketId: begun!.id, state: 'failed', failureCode: 'incomplete' });

    await withSystemDbAccessContext(() => db.delete(tickets).where(eq(tickets.id, begun!.id)));
    const reopened = await openWindow(fx);
    await drive(fx, (await startImportRun(fx, 'import', reopened.id)).id);
    expect((await ledger(fx.sourceId)).get('s1')).toMatchObject({ state: 'removed_in_breeze' });
    expect(await importedTickets(fx)).toEqual([]);
  }, CASE_TIMEOUT);

  runDb('MIGRATION_SOURCE_ID_IN_USE fails the item with its reason; the run goes on', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['live-key', 'fine']);
    // A live ticket already holds this principal's ref for 'live-key'.
    const tech = { kind: 'user' as const, userId: fx.owner.id, name: 'Owner' };
    const live = await withDbAccessContext(fx.ownerContext(), () => createTicket({
      orgId: fx.orgA.id, subject: 'Live', description: 'live', priority: 'normal', source: 'manual',
    } as Parameters<typeof createTicket>[0], tech));
    await withDbAccessContext(fx.ownerContext(), () => upsertTicketExternalRef({
      principalId: fx.principal.id, partnerId: fx.partner.id, ticketId: live.id, externalId: 'live-key', externalUrl: null, externalNumber: null,
    }));
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    expect(await runRow(run.id)).toMatchObject({ state: 'completed' });
    const items = await ledger(fx.sourceId);
    expect(items.get('live-key')).toMatchObject({ state: 'failed', failureCode: 'live_ticket' });
    expect(items.get('fine')).toMatchObject({ state: 'imported' });
  }, CASE_TIMEOUT);

  runDb('a ticket of an unmapped org is skipped as no_org without being loaded', async () => {
    const fx = await seedImport();
    fx.source.tickets = [...fakeTickets(['n1'], { orgKey: 'nowhere' }), ...fakeTickets(['n2'], { orgKey: null })];
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    await drive(fx, run.id);
    expect(fx.source.calls.load).toEqual([]);
    expect((await ledger(fx.sourceId)).get('n1')).toMatchObject({ state: 'skipped', failureCode: 'no_org' });
    expect((await issuesOf(run.id)).filter((i) => i.kind === 'skipped_no_org')).toHaveLength(2);

    // With a fallback, both import into it.
    await setMappings(fx, { orgs: [{ sourceOrgKey: 'acme', sourceOrgName: null, orgId: fx.orgA.id }, { sourceOrgKey: null, sourceOrgName: null, orgId: fx.orgB.id }], categories: [] });
    await drive(fx, (await startImportRun(fx, 'import', window.id)).id);
    expect((await importedTickets(fx)).every((t) => t.orgId === fx.orgB.id)).toBe(true);
  }, CASE_TIMEOUT);

  runDb('a dry run converts and predicts, and writes nothing: no window, no tickets, no ledger', async () => {
    const fx = await seedImport();
    fx.source.tickets = [
      ...fakeTickets(['ok'], {
        comments: [{ id: 'ok-1', at: minutes(5), content: 'Files', files: [
          { id: 'small', filename: 'a.pdf', declaredBytes: 2048 },
          { id: 'huge', filename: 'b.zip', declaredBytes: 20 * 1024 * 1024 },
        ] }],
      }),
      ...fakeTickets(['bad'], { invalid: true }),
      ...fakeTickets(['orphan'], { orgKey: 'nowhere' }),
    ];
    const windowsBefore = await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.partnerId, fx.partner.id));
    const run = await startImportRun(fx, 'dry_run');
    expect(run.windowId).toBeNull();
    await drive(fx, run.id);

    const row = await runRow(run.id);
    expect(row).toMatchObject({ state: 'completed', kind: 'dry_run', windowId: null });
    const counters = normalizeCounters(row.counters);
    expect(counters.predicted).toMatchObject({ creates: 1, comments: 1, attachments: 1, attachmentBytes: 2048, attachmentsSkipped: 1, invalid: 1 });
    expect(counters.tickets).toMatchObject({ seen: 3, created: 0, skipped: 1, failed: 1 });
    expect(fx.source.calls.load.sort()).toEqual(['bad', 'ok']);
    expect(fx.source.calls.files).toEqual([]);
    expect((await issuesOf(run.id)).map((i) => i.kind).sort()).toEqual(['failed', 'skipped_no_org']);

    expect(await importedTickets(fx)).toEqual([]);
    const created = await getTestDb().select({ id: tickets.id }).from(tickets).where(inArray(tickets.orgId, [fx.orgA.id, fx.orgB.id]));
    expect(created).toEqual([]);
    expect(await getTestDb().select().from(ticketImportItems).where(eq(ticketImportItems.sourceId, fx.sourceId))).toEqual([]);
    expect(await getTestDb().select().from(migrationWindows).where(eq(migrationWindows.partnerId, fx.partner.id))).toEqual(windowsBefore);
    expect(s3.objects.size).toBe(0);
  }, CASE_TIMEOUT);

  runDb('a dry run looks refs up once per page, not once per ticket (review #14)', async () => {
    const fx = await seedImport();
    fx.source.pageSize = 5;
    fx.source.tickets = fakeTickets(['p1', 'p2', 'p3', 'p4', 'p5']);
    refLookups.calls = [];
    const run = await startImportRun(fx, 'dry_run');
    await drive(fx, run.id);
    const mine = refLookups.calls.filter((c) => c.principalId === fx.principal.id);
    expect(mine).toEqual([{ principalId: fx.principal.id, keys: ['p1', 'p2', 'p3', 'p4', 'p5'] }]);
    expect(normalizeCounters((await runRow(run.id)).counters).predicted.creates).toBe(5);
  }, CASE_TIMEOUT);

  runDb('versions longer than 64 characters are compared whole (review #15)', async () => {
    const fx = await seedImport();
    const prefix = 'x'.repeat(64);
    fx.source.tickets = fakeTickets(['long'], { version: `${prefix}${'a'.repeat(36)}` });
    const window = await openWindow(fx);
    await drive(fx, (await startImportRun(fx, 'import', window.id)).id);
    const stored = (await ledger(fx.sourceId)).get('long')!;
    expect(stored.importedVersion).toMatch(/^sha256:/);
    expect(stored.importedVersion).toHaveLength(64);

    // Unchanged: not loaded again.
    fx.source.calls.load = [];
    await drive(fx, (await startImportRun(fx, 'import', window.id)).id);
    expect(fx.source.calls.load).toEqual([]);

    // Changed past the 64th character: loaded again, which truncation would have missed.
    fx.source.tickets[0]!.version = `${prefix}${'b'.repeat(36)}`;
    const third = await startImportRun(fx, 'import', window.id);
    await drive(fx, third.id);
    expect(fx.source.calls.load).toEqual(['long']);
    expect(normalizeCounters((await runRow(third.id)).counters).tickets.resumed).toBe(1);
  }, CASE_TIMEOUT);

  runDb('a revoked source stops its run as credentials_revoked', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['x']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    // Revoke is refused while a run is active; simulate a credential gone under it.
    await getTestDb().execute(sql`UPDATE ticket_import_sources SET credentials_encrypted = NULL, revoked_at = now() WHERE id = ${fx.sourceId}`);
    const out = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }), 'tok', { enqueue: async () => undefined });
    expect(out).toEqual({ kind: 'finished', state: 'stopped', stopReason: 'credentials_revoked' });
    expect(fx.source.calls.scan).toBe(0);
  }, CASE_TIMEOUT);

  runDb('a cancelled run stops at the next ticket boundary', async () => {
    const fx = await seedImport();
    fx.source.tickets = fakeTickets(['c1', 'c2', 'c3']);
    const window = await openWindow(fx);
    const run = await startImportRun(fx, 'import', window.id);
    let loads = 0;
    const cancelAfterFirst: typeof importTicket = async (...args) => {
      const result = await importTicket(...args);
      loads += 1;
      if (loads === 1) await getTestDb().execute(sql`UPDATE ticket_import_runs SET state = 'cancelled', finished_at = now() WHERE id = ${run.id}`);
      return result;
    };
    const out = await processTicketImportSlice(sliceJob({ runId: run.id, partnerId: fx.partner.id, seq: 0 }), 'tok', { sliceDeps: { importTicket: cancelAfterFirst }, enqueue: async () => undefined });
    expect(out.kind).toBe('superseded');
    expect(loads).toBe(1);
    expect((await runRow(run.id)).state).toBe('cancelled');
  }, CASE_TIMEOUT);
});
