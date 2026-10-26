import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDocumentV1 } from '@breeze/shared';

/**
 * Tool Catalog W05 (#5220) Task A4 — flow notices. The delegator's in-app
 * notification (W04's pause behaviour, moved here from versions.ts) is sent
 * after commit; the document's notice channel is delivered in PR B (Task B3).
 */

const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<{ label: string; work: () => Promise<unknown> }> }));

vi.mock('../../db', () => ({
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: (label: string, work: () => Promise<unknown>) => { deferred.push({ label, work }); },
}));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';
import { sendFlowNotice } from './notices';

const ORG = '11111111-1111-4111-8111-111111111111';
const FLOW = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const CHANNEL = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';

const flow = (over: Record<string, unknown> = {}) => ({ id: FLOW, name: 'Nightly sync', orgId: ORG, enabledByUserId: USER, ...over });
const doc = (notices?: { channelId: string }) => ({ version: 1, name: 'f', trigger: { type: 'manual' }, inputs: [], steps: [], ...(notices ? { notices } : {}) }) as unknown as FlowDocumentV1;

beforeEach(() => {
  deferred.length = 0;
  vi.mocked(createNotification).mockReset().mockResolvedValue('n1');
  vi.mocked(captureException).mockReset();
});

async function flush() {
  for (const d of deferred.splice(0)) await d.work();
}

describe('sendFlowNotice', () => {
  it('pause notice reaches the delegator in-app, after commit', async () => {
    await sendFlowNotice(flow(), null, {
      kind: 'paused', title: 'Flow paused', text: 'Nightly sync was paused because x.', dedupeKey: `flow-paused:${FLOW}:2:drift`,
      metadata: { flowId: FLOW, reason: 'drift' },
    });
    expect(createNotification).not.toHaveBeenCalled();
    await flush();
    expect(createNotification).toHaveBeenCalledWith({
      userId: USER, orgId: ORG, type: 'automation', priority: 'high', title: 'Flow paused',
      message: 'Nightly sync was paused because x.', link: `/flows/${FLOW}`,
      metadata: { flowId: FLOW, reason: 'drift' }, dedupeKey: `flow-paused:${FLOW}:2:drift`,
    });
  });

  it('no delegator means no in-app notice', async () => {
    await sendFlowNotice(flow({ enabledByUserId: null }), null, { kind: 'cap_reached', title: 't', text: 'x', dedupeKey: 'k' });
    await flush();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('channel delivery is not attempted in PR A', async () => {
    await sendFlowNotice(flow(), doc({ channelId: CHANNEL }), { kind: 'cap_reached', title: 't', text: 'x', dedupeKey: 'k' });
    await flush();
    // The only side effect is the delegator's in-app notice; the channel is PR B's (Task B3).
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createNotification).mock.calls[0]![0]).toMatchObject({ userId: USER });
  });

  it('a notification failure is reported, never thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createNotification).mockRejectedValueOnce(new Error('insert failed'));
    await sendFlowNotice(flow(), null, { kind: 'paused', title: 't', text: 'x', dedupeKey: 'k' });
    await expect(flush()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});
