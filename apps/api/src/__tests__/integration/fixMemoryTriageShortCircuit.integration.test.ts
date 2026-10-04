/**
 * AI Suggested Fixes W3 (#7143, Q1 = C) — live-Postgres proof of the shadow
 * short-circuit through the REAL automation `ai_triage` path: alert event →
 * managed triage automation → execute-run → admission. Harness copied from
 * aiTriageBinding.integration.test.ts.
 *
 * - shadow + an attachable proven fix → no full triage run; the fix is
 *   attached to the alert as an origin='memory' suggestion;
 * - shadow without one → the full run is admitted as before;
 * - act → the full run is admitted, and its context load resolves the fix;
 * - the verdict lane is unchanged.
 *
 * This file must live under `src/__tests__/integration/`; anywhere else it
 * runs in ZERO CI jobs.
 */
import './setup';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { publishEventMock } = vi.hoisted(() => ({
  publishEventMock: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'test-event-id'),
}));
vi.mock('../../services/eventBus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/eventBus')>();
  return { ...actual, publishEvent: publishEventMock };
});

import { db, withSystemDbAccessContext } from '../../db';
import { automationActionResults } from '../../db/schema';
import { shutdownAutomationWorker } from '../../jobs/automationWorker';
import {
  createAndEnqueueAgentRun,
  registerAgentRunEnqueuer,
  type AgentRunEnqueuer,
} from '../../services/aiAgents/runService';
import { loadProvenFixesForRun } from '../../services/fixMemory/runMemory';
import { usePlatformAiKeyPlaceholder } from './helpers/platformAiKey';
import { fireTriage, fullRuns, memorySuggestions, seedProven, seedTriageWorld } from './fixMemoryTriageFixtures';

usePlatformAiKeyPlaceholder();

beforeEach(() => {
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  publishEventMock.mockClear();
  const enqueuer: AgentRunEnqueuer = async (runId) => ({ enqueued: true, jobId: `agent-run:${runId}` });
  registerAgentRunEnqueuer(enqueuer);
});

afterEach(() => {
  registerAgentRunEnqueuer(null);
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await shutdownAutomationWorker();
});

describe('W3 shadow short-circuit through the automation ai_triage path (real Postgres)', () => {
  it('shadow + proven fix → no full triage run, the proven fix is attached, and the action succeeds', async () => {
    const w = await seedTriageWorld('shadow');
    await seedProven(w);
    const automationRunId = await fireTriage(w);

    expect(await fullRuns(w.alertId)).toEqual([]);
    expect((await memorySuggestions(w.alertId)).map((r) => r.scriptId)).toEqual([w.fix.scriptId]);
    const actions = await withSystemDbAccessContext(() => db.select().from(automationActionResults)
      .where(eq(automationActionResults.runId, automationRunId)));
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: 'succeeded' });
  });

  it('shadow without a proven fix → the full run is admitted as today', async () => {
    const w = await seedTriageWorld('shadow');
    await fireTriage(w);
    expect(await fullRuns(w.alertId)).toHaveLength(1);
    expect(await memorySuggestions(w.alertId)).toEqual([]);
  });

  it('act mode → the full run is admitted, and its context load will carry the proven fix', async () => {
    const w = await seedTriageWorld('act');
    await seedProven(w);
    await fireTriage(w);
    const runs = await fullRuns(w.alertId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ modeAtStart: 'act', dedupeKey: `alert:${w.alertId}` });
    const memory = await withSystemDbAccessContext(() => loadProvenFixesForRun({
      orgId: w.orgId, partnerId: w.partnerId, alertId: w.alertId, correlationGroupId: null,
    }));
    expect(memory?.proven.map((p) => p.scriptName)).toEqual([w.fix.name]);
  });

  it('verdict behaviour is unchanged: the verdict lane is admitted even in shadow with a proven fix', async () => {
    const w = await seedTriageWorld('shadow');
    await seedProven(w);
    const verdict = await createAndEnqueueAgentRun({
      orgId: w.orgId, kind: 'triage', profile: 'verdict', triggerKind: 'alert', deviceId: w.deviceId, alertId: w.alertId,
      dedupeKey: `alert-verdict:${w.alertId}`,
    });
    expect(verdict).toMatchObject({ created: true });
  });
});
