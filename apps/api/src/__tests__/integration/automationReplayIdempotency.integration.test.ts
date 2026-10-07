/**
 * #3189 — replay idempotency of automation runs, against real PostgreSQL.
 *
 * BullMQ recovers a stalled `execute-run` job by handing it to another worker
 * while the first may still be alive, and a stalled trigger job by running the
 * trigger handler again. A Drizzle mock cannot prove what two concurrent
 * attempts do to each other; this suite runs them for real:
 *
 *  - two concurrent executions of the same run dispatch each action ONCE, and
 *    both attempts' ledger rows name the one command that exists;
 *  - a later replay of the finished dispatch mints nothing;
 *  - a cancel racing a dispatching run does not deadlock (run row before
 *    action row, everywhere);
 *  - two trigger attempts for the same schedule slot yield one run, while
 *    manual runs (no occurrence key) are never deduplicated.
 *
 * All tenants, devices and commands are synthetic; no agent socket is used, so
 * every command is queued (`pending`) for a heartbeat that never comes.
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  automationActionResults,
  automationRunDeviceResults,
  automationRuns,
  automations,
  deviceCommands,
  devices,
} from '../../db/schema';
import {
  createAutomationRunRecord,
  executeAutomationRun,
} from '../../services/automationRuntime';
import { cancelAutomationRun } from '../../services/automationRunCancellation';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const { publishEventMock } = vi.hoisted(() => ({ publishEventMock: vi.fn().mockResolvedValue('event-id') }));
vi.mock('../../services/eventBus', () => ({ publishEvent: publishEventMock }));

// #8104 — a deterministic interleaving hook. When set, it runs once, right
// before the Nth ledger seed (counted from when it was armed), so a test can
// commit a cancel in the exact window between the runtime's pre-seed fence
// check and a device's ledger insert.
const seedHook = vi.hoisted(() => ({
  beforeSeed: null as null | { remaining: number; run: () => Promise<void> },
}));
vi.mock('../../services/automationActionResults', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/automationActionResults')>();
  return {
    ...actual,
    seedAutomationActionResults: async (...args: Parameters<typeof actual.seedAutomationActionResults>) => {
      const hook = seedHook.beforeSeed;
      if (hook) {
        hook.remaining -= 1;
        if (hook.remaining === 0) {
          seedHook.beforeSeed = null;
          await hook.run();
        }
      }
      return actual.seedAutomationActionResults(...args);
    },
  };
});

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function fixture(deviceCount = 2) {
  const adminDb = getTestDb();
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const deviceRows = await adminDb.insert(devices).values(
    Array.from({ length: deviceCount }, (_, index) => ({
      orgId: org.id,
      siteId: site.id,
      agentId: `replay-${index}-${randomUUID()}`,
      hostname: `replay-${index}`,
      osType: 'linux' as const,
      osVersion: 'test',
      architecture: 'amd64',
      agentVersion: 'test',
      status: 'online' as const,
    })),
  ).returning({ id: devices.id });
  const deviceIds = deviceRows.map((row) => row.id);
  const [automation] = await adminDb.insert(automations).values({
    orgId: org.id,
    partnerId: null,
    name: `Replay idempotency ${randomUUID()}`,
    trigger: { type: 'manual' },
    conditions: { type: 'devices', deviceIds },
    actions: [
      { type: 'execute_command', command: 'synthetic-replay-first' },
      { type: 'execute_command', command: 'synthetic-replay-second' },
    ],
    onFailure: 'stop',
  }).returning();
  const [run] = await adminDb.insert(automationRuns).values({
    automationId: automation!.id,
    triggeredBy: 'replay-integration',
    status: 'running',
    devicesTargeted: deviceIds.length,
  }).returning();
  return { org, automation: automation!, run: run!, deviceIds };
}

async function commandsFor(deviceIds: string[]) {
  return getTestDb()
    .select({ id: deviceCommands.id, deviceId: deviceCommands.deviceId })
    .from(deviceCommands)
    .where(inArray(deviceCommands.deviceId, deviceIds));
}

async function ledgerFor(runId: string) {
  return getTestDb()
    .select({
      deviceId: automationActionResults.deviceId,
      actionIndex: automationActionResults.actionIndex,
      status: automationActionResults.status,
      commandId: automationActionResults.commandId,
    })
    .from(automationActionResults)
    .where(eq(automationActionResults.runId, runId));
}

describe('automation replay idempotency — real PostgreSQL (#3189)', () => {
  runDb('two concurrent executions of one run dispatch every action exactly once', async () => {
    const f = await fixture(2);

    // Two attempts of the same `execute-run` job at once — what stalled-job
    // recovery produces when the first worker is slow rather than dead.
    const outcomes = await Promise.all([
      executeAutomationRun(f.run.id, f.deviceIds),
      executeAutomationRun(f.run.id, f.deviceIds),
    ]);
    for (const outcome of outcomes) {
      // Queued commands never finish here, so the run stays running.
      expect(outcome.status).toBe('running');
    }

    const commands = await commandsFor(f.deviceIds);
    // 2 devices × 2 actions = 4 effects. Without the claim, 8.
    expect(commands).toHaveLength(4);

    const ledger = await ledgerFor(f.run.id);
    expect(ledger).toHaveLength(4);
    for (const row of ledger) {
      expect(row.status).toBe('queued');
      expect(row.commandId).not.toBeNull();
    }
    // Every ledger row names a command that exists, and no command is orphaned
    // from the ledger (an orphan is the duplicate a replay used to mint).
    expect(new Set(ledger.map((row) => row.commandId))).toEqual(new Set(commands.map((row) => row.id)));

    // A later replay of the same job (e.g. the second stall recovery) finds
    // every action claimed and sends nothing.
    await executeAutomationRun(f.run.id, f.deviceIds);
    expect(await commandsFor(f.deviceIds)).toHaveLength(4);
  });

  runDb('a cancel racing a dispatching run neither deadlocks nor loses an action', async () => {
    const f = await fixture(3);

    const [outcome, cancel] = await Promise.all([
      executeAutomationRun(f.run.id, f.deviceIds),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return cancelAutomationRun({ runId: f.run.id, actorId: null, actorLabel: 'replay-integration' });
      })(),
    ]);

    expect(['running', 'cancelled']).toContain(outcome.status);
    expect(cancel.kind).toBe('cancelled');
    // Every action row is either dispatched (with its command) or cancelled
    // before dispatch — never stranded `pending` or `dispatching`.
    const ledger = await ledgerFor(f.run.id);
    for (const row of ledger) {
      expect(['queued', 'cancelled']).toContain(row.status);
      if (row.status === 'queued') expect(row.commandId).not.toBeNull();
    }
    const commands = await commandsFor(f.deviceIds);
    expect(commands).toHaveLength(ledger.filter((row) => row.status === 'queued').length);
  });

  afterEach(() => {
    seedHook.beforeSeed = null;
  });

  it.each([
    { seedsBeforeCancel: 0, label: 'before the first device seed' },
    { seedsBeforeCancel: 1, label: 'between two device seeds' },
  ])('a cancel committing $label strands no pending action or device (#8104)', async ({ seedsBeforeCancel }) => {
    if (!process.env.DATABASE_URL) return;
    const f = await fixture(3);

    // The cancel commits (on its own connection, as the route would) after the
    // runtime's pre-seed fence check passed and right before device N+1's
    // ledger seed — the window the 15 ms race above only sometimes lands in.
    let cancel: Awaited<ReturnType<typeof cancelAutomationRun>> | undefined;
    seedHook.beforeSeed = {
      remaining: seedsBeforeCancel + 1,
      run: async () => {
        cancel = await runOutsideDbContext(() =>
          cancelAutomationRun({ runId: f.run.id, actorId: null, actorLabel: 'replay-integration' }));
      },
    };

    const outcome = await executeAutomationRun(f.run.id, f.deviceIds);

    expect(seedHook.beforeSeed).toBeNull();
    expect(cancel?.kind).toBe('cancelled');
    expect(outcome.status).toBe('cancelled');
    const ledger = await ledgerFor(f.run.id);
    // Only the devices seeded before the cancel have rows (2 actions each);
    // the cancel's own sweep terminalised them and no later seed inserted.
    expect(ledger).toHaveLength(seedsBeforeCancel * 2);
    expect(new Set(ledger.map((row) => row.deviceId)).size).toBe(seedsBeforeCancel);
    for (const row of ledger) {
      expect(row.status).toBe('cancelled');
    }
    expect(await commandsFor(f.deviceIds)).toHaveLength(0);
    // Every device row was seeded `pending` up front; the ones with no action
    // rows must still close, or the run aggregate stays `running` forever.
    const deviceRows = await getTestDb()
      .select({ status: automationRunDeviceResults.status })
      .from(automationRunDeviceResults)
      .where(eq(automationRunDeviceResults.runId, f.run.id));
    expect(deviceRows.map((row) => row.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    const [runRow] = await getTestDb()
      .select({ status: automationRuns.status, completedAt: automationRuns.completedAt })
      .from(automationRuns)
      .where(eq(automationRuns.id, f.run.id));
    expect(runRow!.status).toBe('cancelled');
    expect(runRow!.completedAt).not.toBeNull();
  });

  runDb('two trigger attempts for one schedule slot yield one run; manual runs are never deduplicated', async () => {
    const f = await fixture(1);
    const automationRow = (await getTestDb().select().from(automations).where(eq(automations.id, f.automation.id)))[0]!;

    const occurrenceKey = `schedule:${Date.now()}`;
    const [first, second] = await Promise.all([
      // Each in its own system transaction, as the worker runs a trigger job.
      withSystemDbAccessContext(() => createAutomationRunRecord({
        automation: automationRow, triggeredBy: 'schedule:slot', occurrenceKey,
      })),
      withSystemDbAccessContext(() => createAutomationRunRecord({
        automation: automationRow, triggeredBy: 'schedule:slot', occurrenceKey,
      })),
    ]);
    expect(first.run.id).toBe(second.run.id);
    expect([first.reused, second.reused].sort()).toEqual([false, true]);

    const slotRuns = await getTestDb().select({ id: automationRuns.id }).from(automationRuns).where(and(
      eq(automationRuns.automationId, f.automation.id),
      eq(automationRuns.occurrenceKey, occurrenceKey),
    ));
    expect(slotRuns).toHaveLength(1);
    const [counted] = await getTestDb().select({ runCount: automations.runCount })
      .from(automations).where(eq(automations.id, f.automation.id));
    expect(counted!.runCount).toBe(1);

    const manualA = await withSystemDbAccessContext(() => createAutomationRunRecord({
      automation: automationRow, triggeredBy: 'manual:a',
    }));
    const manualB = await withSystemDbAccessContext(() => createAutomationRunRecord({
      automation: automationRow, triggeredBy: 'manual:b',
    }));
    expect(manualA.run.id).not.toBe(manualB.run.id);
    expect(manualA.reused).toBe(false);
    expect(manualB.reused).toBe(false);
  });
});
