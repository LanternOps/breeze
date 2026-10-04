/**
 * AI Suggested Fixes W3 — fix memory is optional, so a FAILING memory query
 * must never take down the transaction it runs in. Postgres aborts a
 * transaction on any statement error, and postgres.js keeps a caught failure
 * and poisons the outer commit (db/index.ts `withDbTransaction`), so each
 * memory read runs in its own savepoint with the catch outside it.
 *
 * Proven here against real Postgres, by making the memory reads issue a
 * statement that errors (division by zero) on the ambient transaction:
 * - the run context still loads (runLoop.loadRunContext), memory = null;
 * - admission still commits the run when the shadow probe's read fails;
 * - the automation lane still admits the run when the attach after a
 *   short-circuit fails.
 *
 * This file must live under `src/__tests__/integration/`; anywhere else it
 * runs in ZERO CI jobs.
 */
import './setup';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';

const { publishEventMock, failLookup, failAttach } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
  failLookup: { on: false },
  failAttach: { on: false },
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});
/** A SQL error on the AMBIENT transaction — the failure shape under test. */
async function failingStatement(): Promise<never> {
  const { db: ambient } = await import('../../db');
  await ambient.execute(sql`select 1 / 0`);
  throw new Error('unreachable: division by zero did not raise');
}
vi.mock('../../services/fixMemory/lookup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fixMemory/lookup')>();
  return {
    ...actual,
    lookupFixes: async (...args: Parameters<typeof actual.lookupFixes>) => {
      if (failLookup.on) return failingStatement();
      return actual.lookupFixes(...args);
    },
  };
});
vi.mock('../../services/fixMemory/attach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/fixMemory/attach')>();
  return {
    ...actual,
    attachProvenFixes: async (...args: Parameters<typeof actual.attachProvenFixes>) => {
      if (failAttach.on) return failingStatement();
      return actual.attachProvenFixes(...args);
    },
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns, automationActionResults } from '../../db/schema';
import { shutdownAutomationWorker } from '../../jobs/automationWorker';
import { __loadRunContextForTests } from '../../services/aiAgents/runLoop';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';
import { fireTriage, fullRuns, memorySuggestions, seedProven, seedTriageWorld } from './fixMemoryTriageFixtures';

usePlatformAiKeyPlaceholder();

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  failLookup.on = false;
  failAttach.on = false;
  const enqueuer: AgentRunEnqueuer = async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` });
  registerAgentRunEnqueuer(enqueuer);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

afterAll(async () => {
  await shutdownAutomationWorker();
});

describe('a failing fix-memory query never poisons its transaction (real Postgres)', () => {
  it('admission: the shadow probe’s read fails → the full run is still admitted AND committed', async () => {
    const w = await seedTriageWorld('shadow');
    failLookup.on = true;
    const result = await createAndEnqueueAgentRun({
      orgId: w.orgId, kind: 'triage', triggerKind: 'alert', deviceId: w.deviceId, alertId: w.alertId,
      dedupeKey: `alert:${w.alertId}`,
      provenFixProbe: async () => {
        const { hasAttachableProvenFix } = await import('../../services/fixMemory/attach');
        return hasAttachableProvenFix({ sourceType: 'alert', sourceId: w.alertId, orgId: w.orgId });
      },
    });
    expect(result).toMatchObject({ created: true });
    // Committed — read back on a fresh transaction.
    const rows = await withSystemDbAccessContext(() => db.select({ id: aiAgentRuns.id }).from(aiAgentRuns)
      .where(eq(aiAgentRuns.alertId, w.alertId)));
    expect(rows).toHaveLength(1);
  });

  it('run context: the memory lookup fails → loadRunContext still loads, with no memory', async () => {
    const w = await seedTriageWorld('shadow');
    const admitted = await createAndEnqueueAgentRun({
      orgId: w.orgId, kind: 'triage', triggerKind: 'alert', deviceId: w.deviceId, alertId: w.alertId,
      dedupeKey: `alert:${w.alertId}`,
    });
    if (!admitted.created) throw new Error(`expected an admitted run, got ${admitted.skipped}`);
    failLookup.on = true;
    const ctx = await __loadRunContextForTests(admitted.run.id);
    expect(ctx).not.toBeNull();
    expect(ctx!.alert).toMatchObject({ title: 'exit 3' });
    expect(ctx!.provenFixes ?? null).toBeNull();
  });

  it('automation lane: the attach after proven_fix_available fails → the full run is admitted instead', async () => {
    const w = await seedTriageWorld('shadow');
    await seedProven(w);
    failAttach.on = true;
    const automationRunId = await fireTriage(w);
    expect(await fullRuns(w.alertId)).toHaveLength(1);
    expect(await memorySuggestions(w.alertId)).toEqual([]);
    const actions = await withSystemDbAccessContext(() => db.select().from(automationActionResults)
      .where(eq(automationActionResults.runId, automationRunId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.status).toBe('queued');
  });
});
