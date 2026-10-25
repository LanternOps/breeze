import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Tool catalog W04 (#5219), plan Task A8 — which terminal status publishes which flow.run event. */
const h = vi.hoisted(() => ({
  publishEvent: vi.fn(async () => 'evt'),
  createNotification: vi.fn(async () => 'n'),
  captureException: vi.fn(),
}));

vi.mock('../eventBus', () => ({ publishEvent: h.publishEvent }));
vi.mock('../userNotifications', () => ({ createNotification: h.createNotification }));
vi.mock('../sentry', () => ({ captureException: h.captureException }));
vi.mock('../../db', () => ({
  withSystemDbAccessContext: async (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

import { notifyFlowRunUnknownOutcome, publishFlowRunTerminalEvent } from './runEvents';

const RUN = { id: 'bbbbbbbb-0000-4000-8000-000000000001', orgId: 'cccccccc-0000-4000-8000-000000000001', flowId: 'eeeeeeee-0000-4000-8000-000000000001', chainDepth: 2 };

beforeEach(() => vi.clearAllMocks());

describe('publishFlowRunTerminalEvent', () => {
  it.each([
    ['completed', 'flow.run.completed'],
    ['failed', 'flow.run.failed'],
    ['expired', 'flow.run.failed'],
  ] as const)('%s ⇒ %s with the run as ancestry', async (status, type) => {
    await publishFlowRunTerminalEvent(RUN, status);
    expect(h.publishEvent).toHaveBeenCalledWith(
      type,
      RUN.orgId,
      { flowId: RUN.flowId, runId: RUN.id, chainDepth: 2, status },
      'flow-runner',
      { flowRunId: RUN.id, flowChainDepth: 2 },
    );
  });

  it('cancelled publishes nothing', async () => {
    await publishFlowRunTerminalEvent(RUN, 'cancelled');
    expect(h.publishEvent).not.toHaveBeenCalled();
  });

  it('a publish failure is reported, never thrown (the run is already terminal)', async () => {
    h.publishEvent.mockRejectedValueOnce(new Error('redis down'));
    await expect(publishFlowRunTerminalEvent(RUN, 'failed')).resolves.toBeUndefined();
    expect(h.captureException).toHaveBeenCalledTimes(1);
  });
});

describe('notifyFlowRunUnknownOutcome', () => {
  it('notifies the delegator once per run (dedupe key) with a run link', async () => {
    await notifyFlowRunUnknownOutcome({ delegatorUserId: 'u1', orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'Disk cleanup', runId: RUN.id, stepId: 'fix' });
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: RUN.orgId, priority: 'high', link: `/flows/runs/${RUN.id}`, dedupeKey: `flow-run-unknown:${RUN.id}`,
    }));
  });

  it('no delegator (erased user) ⇒ nothing to notify', async () => {
    await notifyFlowRunUnknownOutcome({ delegatorUserId: null, orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'x', runId: RUN.id, stepId: 'fix' });
    expect(h.createNotification).not.toHaveBeenCalled();
  });
});
