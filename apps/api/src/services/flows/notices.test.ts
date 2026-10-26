import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowDocumentV1 } from '@breeze/shared';

/**
 * Tool Catalog W05 (#5220) Task A4 — flow notices. The delegator's in-app
 * notification (W04's pause behaviour, moved here from versions.ts) is sent
 * after commit; the document's notice channel is delivered in PR B (Task B3).
 */

const { deferred } = vi.hoisted(() => ({ deferred: [] as Array<{ label: string; work: () => Promise<unknown> }> }));

const { sendChannelMessage, dbRows } = vi.hoisted(() => ({ sendChannelMessage: vi.fn(), dbRows: [] as unknown[][] }));

vi.mock('../notificationSenders/channelMessage', () => ({ sendChannelMessage }));
vi.mock('../../db', () => ({
  // Each select() consumes the next queued result: flows row, flow_versions row, organizations row.
  db: { select: () => ({ from: () => ({ where: () => ({ limit: async () => dbRows.shift() ?? [] }) }) }) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runAfterDbContextCommit: (label: string, work: () => Promise<unknown>) => { deferred.push({ label, work }); },
}));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn() }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
const { redisState } = vi.hoisted(() => ({ redisState: { claimed: new Set<string>(), available: true } }));
vi.mock('../redis', () => ({
  getRedis: () => (redisState.available
    ? {
        set: async (key: string, _v: string, _ex: string, _ttl: number, _nx: string) => {
          if (redisState.claimed.has(key)) return null;
          redisState.claimed.add(key);
          return 'OK';
        },
        del: async (key: string) => (redisState.claimed.delete(key) ? 1 : 0),
      }
    : null),
}));

import { createNotification } from '../userNotifications';
import { captureException } from '../sentry';
import { sendFlowNotice, sendFlowNoticeToChannel } from './notices';

const ORG = '11111111-1111-4111-8111-111111111111';
const FLOW = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const CHANNEL = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';

const flow = (over: Record<string, unknown> = {}) => ({ id: FLOW, name: 'Nightly sync', orgId: ORG, enabledByUserId: USER, ...over });
const doc = (notices?: { channelId: string }) => ({ version: 1, name: 'f', trigger: { type: 'manual' }, inputs: [], steps: [], ...(notices ? { notices } : {}) }) as unknown as FlowDocumentV1;

beforeEach(() => {
  deferred.length = 0;
  dbRows.length = 0;
  redisState.claimed.clear();
  redisState.available = true;
  sendChannelMessage.mockReset().mockResolvedValue({ ok: true, channelId: CHANNEL, channelType: 'slack' });
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

  const PARTNER = '55555555-5555-4555-8555-555555555555';
  const queueLive = (channelId: string | null, flowRow: Record<string, unknown> = { orgId: ORG, partnerId: null, enabledPublicationSeq: 3 }) => {
    dbRows.push([flowRow]);
    dbRows.push([{ definition: channelId ? { notices: { channelId } } : {} }]);
    if (flowRow.orgId) dbRows.push([{ partnerId: PARTNER }]);
  };
  const pause = { kind: 'paused' as const, title: 'Flow paused', text: 'Nightly sync was paused because x.', dedupeKey: 'k' };

  it('pause notice also goes to the notice channel', async () => {
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, pause);
    expect(sendChannelMessage).not.toHaveBeenCalled();
    await flush();
    expect(sendChannelMessage).toHaveBeenCalledWith(
      CHANNEL,
      { title: 'Flow paused', body: 'Nightly sync was paused because x.', severity: 'warning', link: `/flows/${FLOW}` },
      { orgId: ORG, partnerId: PARTNER },
    );
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('a cap notice is info severity and a passed doc supplies the channel', async () => {
    await sendFlowNotice(flow(), doc({ channelId: CHANNEL }), { kind: 'cap_reached', title: 't', text: 'x', dedupeKey: 'k' });
    dbRows.push([{ orgId: ORG, partnerId: null, enabledPublicationSeq: 3 }], [{ partnerId: PARTNER }]);
    await flush();
    expect(sendChannelMessage).toHaveBeenCalledWith(CHANNEL, expect.objectContaining({ severity: 'info' }), { orgId: ORG, partnerId: PARTNER });
  });

  it('partner-wide flow uses the flow row partner as owner', async () => {
    queueLive(CHANNEL, { orgId: null, partnerId: PARTNER, enabledPublicationSeq: 1 });
    await sendFlowNotice(flow({ orgId: null }), null, pause);
    await flush();
    expect(sendChannelMessage).toHaveBeenCalledWith(CHANNEL, expect.anything(), { orgId: null, partnerId: PARTNER });
  });

  it('no notice channel means no channel send', async () => {
    queueLive(null);
    await sendFlowNotice(flow(), null, pause);
    await flush();
    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
  });

  it('an unreadable publication means no channel send', async () => {
    dbRows.push([{ orgId: ORG, partnerId: null, enabledPublicationSeq: null }]);
    await sendFlowNotice(flow(), null, pause);
    await flush();
    expect(sendChannelMessage).not.toHaveBeenCalled();
  });

  it('channel failure never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueLive(CHANNEL);
    sendChannelMessage.mockRejectedValueOnce(new Error('boom'));
    await sendFlowNotice(flow(), null, pause);
    await expect(flush()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(vi.mocked(captureException).mock.calls[0]![2]).toMatchObject({ flow_id: FLOW, flow_site: 'flows.notice.channel' });
    err.mockRestore();
  });

  it('an ok:false channel result is reported, never thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    queueLive(CHANNEL);
    sendChannelMessage.mockResolvedValueOnce({ ok: false, code: 'throttled', message: 'slow down' });
    await sendFlowNotice(flow(), null, pause);
    await expect(flush()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('channel send happens even without a delegator', async () => {
    queueLive(CHANNEL);
    await sendFlowNotice(flow({ enabledByUserId: null }), null, pause);
    await flush();
    expect(createNotification).not.toHaveBeenCalled();
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
  });

  it('a notification failure is reported, never thrown', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(createNotification).mockRejectedValueOnce(new Error('insert failed'));
    await sendFlowNotice(flow(), null, { kind: 'paused', title: 't', text: 'x', dedupeKey: 'k' });
    await expect(flush()).resolves.toBeUndefined();
    expect(captureException).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  // The cap marker re-fires up to once a minute while a flow sits at its
  // cap; the in-app notice dedupes on its key in the DB, so the channel must
  // dedupe on the same key or it is spammed every minute.
  it('a repeated notice with the same dedupe key reaches the channel once', async () => {
    const cap = { kind: 'cap_reached' as const, title: 'Flow runs refused', text: 'x', dedupeKey: `flow-cap:${FLOW}:2027-01:flow_monthly_cap_reached` };
    for (let i = 0; i < 3; i++) {
      queueLive(CHANNEL);
      await sendFlowNotice(flow(), null, cap);
      await flush();
    }
    expect(sendChannelMessage).toHaveBeenCalledTimes(1);
    expect(createNotification).toHaveBeenCalledTimes(3); // the DB dedupes these
  });

  // Review round: a failed send must not burn the once-per-key slot for 35 days.
  it('a failed or throwing channel send releases its dedupe key so the next notice retries; a throttled one keeps it', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cap = { kind: 'cap_reached' as const, title: 't', text: 'x', dedupeKey: 'flow-cap:k1' };
    sendChannelMessage.mockResolvedValueOnce({ ok: false, code: 'send_failed', message: 'Slack 503' });
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, cap);
    await flush();
    expect(redisState.claimed.has('flow-notice-channel:flow-cap:k1')).toBe(false);
    sendChannelMessage.mockRejectedValueOnce(new Error('boom'));
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, cap);
    await flush();
    expect(redisState.claimed.has('flow-notice-channel:flow-cap:k1')).toBe(false);
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, cap);
    await flush();
    expect(sendChannelMessage).toHaveBeenCalledTimes(3);
    expect(redisState.claimed.has('flow-notice-channel:flow-cap:k1')).toBe(true);
    // A throttled channel did its job (its own cap): the slot stays claimed.
    sendChannelMessage.mockResolvedValueOnce({ ok: false, code: 'throttled', message: 'cap' });
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, { ...cap, dedupeKey: 'flow-cap:k2' });
    await flush();
    expect(redisState.claimed.has('flow-notice-channel:flow-cap:k2')).toBe(true);
    err.mockRestore();
  });

  it('without Redis the channel send is skipped (never spam), the in-app notice still goes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redisState.available = false;
    queueLive(CHANNEL);
    await sendFlowNotice(flow(), null, pause);
    await flush();
    expect(sendChannelMessage).not.toHaveBeenCalled();
    expect(createNotification).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a flow without a notice channel claims no dedupe key (a channel added later still gets the next notice)', async () => {
    queueLive(null);
    await sendFlowNotice(flow(), null, pause);
    await flush();
    expect(redisState.claimed.size).toBe(0);
  });
});

describe('sendFlowNoticeToChannel', () => {
  it('sends the channel half alone (the unknown-outcome path keeps its own in-app notice)', async () => {
    dbRows.push([{ orgId: ORG, partnerId: null, enabledPublicationSeq: 3 }], [{ definition: { notices: { channelId: CHANNEL } } }], [{ partnerId: '55555555-5555-4555-8555-555555555555' }]);
    await sendFlowNoticeToChannel({ id: FLOW, orgId: ORG }, null, { kind: 'unknown_outcome', title: 'Flow run needs review', text: 'y', dedupeKey: 'flow-run-unknown:r1' });
    await flush();
    expect(sendChannelMessage).toHaveBeenCalledWith(CHANNEL, expect.objectContaining({ title: 'Flow run needs review', severity: 'warning' }), { orgId: ORG, partnerId: '55555555-5555-4555-8555-555555555555' });
    expect(createNotification).not.toHaveBeenCalled();
  });
});
