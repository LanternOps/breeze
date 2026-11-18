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
const { noticesMock } = vi.hoisted(() => ({ noticesMock: { sendFlowNoticeToChannel: vi.fn(async () => {}) } }));
vi.mock('./notices', () => noticesMock);

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
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(publishFlowRunTerminalEvent(RUN, 'failed')).resolves.toBeUndefined();
    // The event is lost (no outbox in W04), so the log line and the capture
    // must both name the run, its flow and its org.
    expect(h.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { org_id: RUN.orgId, flow_id: RUN.flowId, flow_run_id: RUN.id, flow_site: 'runEvents.publish_terminal' },
      { fingerprint: ['flow', 'runEvents.publish_terminal'] },
    );
    const line = String(errorLog.mock.calls[0]?.[0]);
    expect(line).toContain(RUN.id);
    expect(line).toContain(RUN.flowId);
    expect(line).toContain(RUN.orgId);
    expect(line).toContain('flow.run.failed');
    errorLog.mockRestore();
  });
});

describe('notifyFlowRunUnknownOutcome', () => {
  it('notifies the delegator once per run (dedupe key) with a run link', async () => {
    await notifyFlowRunUnknownOutcome({ delegatorUserId: 'u1', orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'Disk cleanup', runId: RUN.id, stepId: 'fix' });
    expect(h.createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', orgId: RUN.orgId, priority: 'high', link: `/flows/runs/${RUN.id}`, dedupeKey: `flow-run-unknown:${RUN.id}`,
    }));
  });

  it('a notification failure is reported with the run ids, never thrown', async () => {
    h.createNotification.mockRejectedValueOnce(new Error('db down'));
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(notifyFlowRunUnknownOutcome({ delegatorUserId: 'u1', orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'x', runId: RUN.id, stepId: 'fix' }))
      .resolves.toBeUndefined();
    expect(h.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      undefined,
      { org_id: RUN.orgId, flow_id: RUN.flowId, flow_run_id: RUN.id, flow_site: 'runEvents.notify_unknown_outcome' },
      { fingerprint: ['flow', 'runEvents.notify_unknown_outcome'] },
    );
    errorLog.mockRestore();
  });

  it('no delegator (erased user) ⇒ no in-app notice', async () => {
    await notifyFlowRunUnknownOutcome({ delegatorUserId: null, orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'x', runId: RUN.id, stepId: 'fix' });
    expect(h.createNotification).not.toHaveBeenCalled();
  });

  // W5 PR B (#5220, Decision 14): an unknown_outcome run also reaches the flow's notice channel.
  it('also goes to the notice channel, once per run, with or without a delegator', async () => {
    for (const delegatorUserId of ['u1', null]) {
      noticesMock.sendFlowNoticeToChannel.mockClear();
      await notifyFlowRunUnknownOutcome({ delegatorUserId, orgId: RUN.orgId, flowId: RUN.flowId, flowName: 'Disk cleanup', runId: RUN.id, stepId: 'fix' });
      expect(noticesMock.sendFlowNoticeToChannel).toHaveBeenCalledWith(
        { id: RUN.flowId, orgId: RUN.orgId },
        null,
        expect.objectContaining({ kind: 'unknown_outcome', title: 'Flow run needs review', dedupeKey: `flow-run-unknown:${RUN.id}` }),
      );
    }
  });
});
