import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const updateWhereCalls: { col: string; val: unknown }[] = [];
const updateSetCalls: Record<string, unknown>[] = [];

vi.mock('../db', () => {
  const db = {
    update: vi.fn(() => ({
      set: (vals: Record<string, unknown>) => {
        updateSetCalls.push(vals);
        return {
          where: (clause: unknown) => {
            updateWhereCalls.push({ col: 'where', val: clause });
            return Promise.resolve();
          },
        };
      },
    })),
    select: vi.fn(),
  };
  return { db };
});

vi.mock('../db/schema/mobile', () => ({
  mobileDevices: {
    apnsToken: { name: 'apnsToken' },
    fcmToken: { name: 'fcmToken' },
    userId: { name: 'userId' },
    notificationsEnabled: { name: 'notificationsEnabled' },
    platform: { name: 'platform' },
    status: { name: 'status' },
  },
}));

const sendApnsNotificationMock = vi.fn();
vi.mock('./apns', () => ({
  sendApnsNotification: (...args: unknown[]) => sendApnsNotificationMock(...args),
}));

import {
  sendExpoPush,
  buildApprovalPush,
  getUserPushTokens,
  dispatchApprovalPush,
  buildTimeSuggestionPush,
  timeSuggestionsDedupeKey,
  APPROVAL_PUSH_TTL_SECONDS,
  TIME_SUGGESTION_PUSH_TTL_SECONDS,
  TIME_SUGGESTIONS_PUSH_EVENT_TYPE,
  buildTicketPush,
  dispatchPushToTokens,
  dispatchApprovalPushToTokens,
} from './expoPush';
import { readFileSync } from 'fs';
import { db } from '../db';

/** Wires db.select(...).from(...).where(...) to resolve to `rows`. */
function stubSelectRows(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  } as unknown as ReturnType<typeof db.select>);
}

describe('buildApprovalPush', () => {
  it('limits the body to client label + action label only', () => {
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: 'Delete 4 devices in Acme Corp',
      requestingClientLabel: 'Claude Desktop',
    });
    expect(msg.title).toBe('Approval requested');
    expect(msg.body).toBe('Claude Desktop: Delete 4 devices in Acme Corp');
    expect(msg.data).toEqual({ type: 'approval', approvalId: 'a1' });
    expect(msg.priority).toBe('high');
    expect(msg.ttl).toBe(60);
  });

  it('truncates client + action labels to 60 chars', () => {
    const longClient = 'C'.repeat(120);
    const longAction = 'A'.repeat(120);
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: longAction,
      requestingClientLabel: longClient,
    });
    expect(msg.body).toBe(`${'C'.repeat(60)}: ${'A'.repeat(60)}`);
  });

  it('never leaks actionArguments into the push body (security invariant)', () => {
    const dangerous = JSON.stringify({ ids: ['device-1', 'device-2'] });
    const msg = buildApprovalPush({
      approvalId: 'a1',
      actionLabel: 'Delete devices',
      requestingClientLabel: 'Claude Desktop',
    } as unknown as Parameters<typeof buildApprovalPush>[0] & { actionArguments: string });
    expect(msg.body).not.toContain(dangerous);
    expect(msg.body).not.toContain('device-1');
    expect(msg.body).not.toContain('ids');
  });
});

describe('sendExpoPush', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    updateWhereCalls.length = 0;
    updateSetCalls.length = 0;
    vi.mocked(db.update).mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns [] when given no messages without hitting the network', async () => {
    const tickets = await sendExpoPush([]);
    expect(tickets).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('POSTs to the Expo Push endpoint and returns tickets', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'tk1' }] }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[abc]', title: 't', body: 'b' },
    ]);
    expect(tickets).toEqual([{ status: 'ok', id: 'tk1' }]);
    expect(fetch).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('throws when Expo returns non-2xx', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'oops',
    } as unknown as Response);
    await expect(
      sendExpoPush([{ to: 'ExponentPushToken[abc]', title: 't', body: 'b' }])
    ).rejects.toThrow(/Expo push failed: 500/);
  });

  it('marks DeviceNotRegistered tokens inactive in DB', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { status: 'ok', id: 'tk1' },
          {
            status: 'error',
            message: 'device not registered',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[good]', title: 't', body: 'b' },
      { to: 'ExponentPushToken[dead]', title: 't', body: 'b' },
    ]);

    expect(tickets).toHaveLength(2);
    expect(db.update).toHaveBeenCalled();
    // One DeviceNotRegistered → 2 update calls (apns + fcm clear branches)
    expect(vi.mocked(db.update).mock.calls.length).toBeGreaterThanOrEqual(2);
    // Both updates set the corresponding token column to null
    const nullSets = updateSetCalls.filter(
      (s) => s.apnsToken === null || s.fcmToken === null
    );
    expect(nullSets.length).toBeGreaterThanOrEqual(2);
  });

  it('does not log the full Expo push token on ticket error (SR-004)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secretToken = 'ExponentPushToken[SUPERSECRETPUSHADDRESS12345]';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'too many',
            details: { error: 'MessageRateExceeded' },
          },
        ],
      }),
    } as unknown as Response);

    await sendExpoPush([{ to: secretToken, title: 't', body: 'b' }]);

    expect(errSpy).toHaveBeenCalled();
    const logged = JSON.stringify(errSpy.mock.calls);
    // The raw, reusable push address must never appear in logs.
    expect(logged).not.toContain(secretToken);
    expect(logged).not.toContain('SUPERSECRETPUSHADDRESS12345');
    // A redacted reference (last-4 suffix) is still useful for correlation.
    expect(logged).toContain('345]');
    errSpy.mockRestore();
  });

  it('still clears DeviceNotRegistered tokens using the full token despite redacted logging (SR-004)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const deadToken = 'ExponentPushToken[DEADTOKENFULLVALUE99999]';
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'gone',
            details: { error: 'DeviceNotRegistered' },
          },
        ],
      }),
    } as unknown as Response);

    await sendExpoPush([{ to: deadToken, title: 't', body: 'b' }]);

    // DB cleanup must still receive the FULL token (matching the stored column).
    const fullTokenUsed = updateWhereCalls.length > 0;
    expect(fullTokenUsed).toBe(true);
    // But the log must not contain it.
    const logged = JSON.stringify(errSpy.mock.calls);
    expect(logged).not.toContain(deadToken);
    errSpy.mockRestore();
  });

  it('logs but does not mark inactive on non-DeviceNotRegistered ticket errors', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            status: 'error',
            message: 'too many',
            details: { error: 'MessageRateExceeded' },
          },
        ],
      }),
    } as unknown as Response);

    const tickets = await sendExpoPush([
      { to: 'ExponentPushToken[abc]', title: 't', body: 'b' },
    ]);

    expect(tickets).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe('getUserPushTokens provider tagging', () => {
  beforeEach(() => {
    vi.mocked(db.select).mockReset();
  });

  it('tags an Expo-prefixed token as provider "expo" regardless of platform', async () => {
    stubSelectRows([{ fcm: null, apns: 'ExponentPushToken[abc]', platform: 'ios' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'ExponentPushToken[abc]', platform: 'ios', provider: 'expo' },
    ]);
  });

  it('tags a raw token on an ios row as native "apns" (no longer dropped)', async () => {
    stubSelectRows([{ fcm: null, apns: 'a'.repeat(64), platform: 'ios' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'a'.repeat(64), platform: 'ios', provider: 'apns' },
    ]);
  });

  it('tags a raw token on an android row as native "fcm"', async () => {
    stubSelectRows([{ fcm: 'fcm-native-token', apns: null, platform: 'android' }]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'fcm-native-token', platform: 'android', provider: 'fcm' },
    ]);
  });

  it('emits one tagged entry per non-null token across a mixed fleet', async () => {
    stubSelectRows([
      { fcm: null, apns: 'ExponentPushToken[expo-ios]', platform: 'ios' },
      { fcm: null, apns: 'native-apns-token', platform: 'ios' },
      { fcm: 'native-fcm-token', apns: null, platform: 'android' },
      { fcm: null, apns: null, platform: 'ios' }, // no tokens → contributes nothing
    ]);
    const tokens = await getUserPushTokens('u1');
    expect(tokens).toEqual([
      { token: 'ExponentPushToken[expo-ios]', platform: 'ios', provider: 'expo' },
      { token: 'native-apns-token', platform: 'ios', provider: 'apns' },
      { token: 'native-fcm-token', platform: 'android', provider: 'fcm' },
    ]);
  });
});

describe('dispatchApprovalPush routing', () => {
  const pushArgs = {
    approvalId: 'ap-1',
    actionLabel: 'Delete devices',
    requestingClientLabel: 'Claude Desktop',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.mocked(db.select).mockReset();
    vi.mocked(db.update).mockClear();
    sendApnsNotificationMock.mockReset();
    updateWhereCalls.length = 0;
    updateSetCalls.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns zeros and touches no provider when the user has no tokens', async () => {
    stubSelectRows([]);
    const res = await dispatchApprovalPush('u1', pushArgs);
    expect(res).toEqual({ tokensFound: 0, dispatched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendApnsNotificationMock).not.toHaveBeenCalled();
  });

  it('routes Expo tokens to the Expo relay and native ios tokens to APNs', async () => {
    stubSelectRows([
      { fcm: null, apns: 'ExponentPushToken[expo]', platform: 'ios' },
      { fcm: null, apns: 'native-apns-token', platform: 'ios' },
    ]);
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ status: 'ok', id: 'tk1' }] }),
    } as unknown as Response);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: true, status: 200 });

    const res = await dispatchApprovalPush('u1', pushArgs);

    // Expo relay received exactly the one Expo token.
    expect(fetch).toHaveBeenCalledTimes(1);
    const expoBody = JSON.parse(
      (fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body as string,
    );
    expect(expoBody).toHaveLength(1);
    expect(expoBody[0].to).toBe('ExponentPushToken[expo]');
    expect(expoBody[0].title).toBe('Approval requested');

    // Native APNs sender received exactly the raw ios token with the 60s ttl.
    expect(sendApnsNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendApnsNotificationMock).toHaveBeenCalledWith(
      'native-apns-token',
      expect.objectContaining({
        title: 'Approval requested',
        body: 'Claude Desktop: Delete devices',
        ttl: 60,
      }),
    );

    expect(res).toEqual({ tokensFound: 2, dispatched: 2, errors: 0 });
  });

  it('purges the apns column when the native sender reports the token unregistered', async () => {
    stubSelectRows([{ fcm: null, apns: 'dead-apns-token', platform: 'ios' }]);
    sendApnsNotificationMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      reason: 'Unregistered',
      unregistered: true,
    });

    const res = await dispatchApprovalPush('u1', pushArgs);

    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
    // The dead token was purged from the apnsToken column.
    expect(db.update).toHaveBeenCalled();
    expect(updateSetCalls.some((s) => s.apnsToken === null)).toBe(true);
    expect(updateWhereCalls.length).toBeGreaterThanOrEqual(1);
    // A live-but-failed (non-unregistered) result must NOT purge.
    expect(fetch).not.toHaveBeenCalled();
  });

  it('counts a native failure as an error without purging when not unregistered', async () => {
    stubSelectRows([{ fcm: null, apns: 'apns-token', platform: 'ios' }]);
    sendApnsNotificationMock.mockResolvedValueOnce({ ok: false, status: 400, reason: 'BadRequest' });

    const res = await dispatchApprovalPush('u1', pushArgs);

    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 1 });
    expect(db.update).not.toHaveBeenCalled();
  });

  it('counts native android (fcm) tokens as found-but-skipped, not errors', async () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    stubSelectRows([{ fcm: 'native-fcm-token', apns: null, platform: 'android' }]);

    const res = await dispatchApprovalPush('u1', pushArgs);

    // Counted in tokensFound, but neither dispatched nor errored — FCM is not wired.
    expect(res).toEqual({ tokensFound: 1, dispatched: 0, errors: 0 });
    expect(fetch).not.toHaveBeenCalled();
    expect(sendApnsNotificationMock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('not wired to FCM'));
    infoSpy.mockRestore();
  });
});

// ── W06 (#3900): payload builder only. W07 owns the scheduler, quiet hours,
// the dedupe write and the mobile listener. ─────────────────────────────────
describe('buildTimeSuggestionPush (W06 #3900, dispatched by W07)', () => {
  it('pluralises the count and carries only the date in data', () => {
    expect(buildTimeSuggestionPush({ count: 3, date: '2026-08-29' })).toEqual({
      title: '3 unlogged sessions today',
      body: 'Tap to review and log your remote sessions.',
      data: { type: 'time_suggestions', date: '2026-08-29' },
      sound: 'default',
      priority: 'normal',
      channelId: 'timesheet',
      ttl: TIME_SUGGESTION_PUSH_TTL_SECONDS,
    });
    expect(buildTimeSuggestionPush({ count: 1, date: '2026-08-29' }).title).toBe('1 unlogged session today');
  });

  it('is lock-screen safe: no device hostname, org name, ticket number or customer string anywhere', () => {
    const p = buildTimeSuggestionPush({ count: 2, date: '2026-08-29' });
    const blob = JSON.stringify(p);
    for (const leak of ['ACME', 'DC01', 'TKT-', 'hostname', 'orgId', 'ticketId', 'deviceId']) {
      expect(blob).not.toContain(leak);
    }
    // The payload is a pure function of (count, date) — nothing else can enter it.
    expect(Object.keys(p.data!)).toEqual(['type', 'date']);
  });

  it('does not disturb buildApprovalPush', () => {
    expect(buildApprovalPush({ approvalId: 'a1', actionLabel: 'Restart', requestingClientLabel: 'Bob' }))
      .toEqual({
        title: 'Approval requested',
        body: 'Bob: Restart',
        data: { type: 'approval', approvalId: 'a1' },
        sound: 'default',
        priority: 'high',
        channelId: 'approvals',
        ttl: APPROVAL_PUSH_TTL_SECONDS,
      });
  });

  it('reserves the event type and a per-user-per-day dedupe key', () => {
    expect(TIME_SUGGESTIONS_PUSH_EVENT_TYPE).toBe('time_suggestions_daily');
    expect(timeSuggestionsDedupeKey('u1', '2026-08-29')).toBe('time.unlogged:u1:2026-08-29');
    // Same user, same day -> same key: W07's dedupe is a DB unique index, so
    // the key must be stable across processes (F16).
    expect(timeSuggestionsDedupeKey('u1', '2026-08-29')).toBe(timeSuggestionsDedupeKey('u1', '2026-08-29'));
    expect(timeSuggestionsDedupeKey('u2', '2026-08-29')).not.toBe(timeSuggestionsDedupeKey('u1', '2026-08-29'));
  });

  it('a 12h TTL: a phone that was off all evening does not get yesterday’s nudge at breakfast', () => {
    expect(TIME_SUGGESTION_PUSH_TTL_SECONDS).toBe(12 * 60 * 60);
  });

  it('W06 dispatches no time-suggestion push', () => {
    // Guard against a well-meaning follow-up wiring dispatch in early.
    const src = readFileSync(new URL('./expoPush.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dispatchTimeSuggestionPush|sendExpoPush\([^)]*TimeSuggestion/);
  });
});

// ---------------------------------------------------------------------------
// W07 (#3901): generalised push spec + ticket pushes
// ---------------------------------------------------------------------------

describe('buildTicketPush', () => {
  it('assigned: lock-screen-safe body, 24h ttl, collapse/thread ids, no subject', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-2026-0042', orgName: 'Acme' });
    expect(spec.title).toBe('Ticket assigned to you');
    expect(spec.body).toBe('T-2026-0042 \u00b7 Acme');
    expect(spec.data).toEqual({ type: 'ticket', ticketId: 't-1', reason: 'assigned', internalNumber: 'T-2026-0042' });
    expect(spec.ttl).toBe(86400);
    expect(spec.collapseId).toBe('ticket:t-1:assigned');
    expect(spec.threadId).toBe('ticket:t-1');
    expect(spec.category).toBe('BREEZE_TICKET');
    expect(spec.channelId).toBe('tickets');
    expect(JSON.stringify(spec)).not.toContain('subject');
  });
  it('sla_breached: target in title/collapse, 4h ttl, "Ticket" fallback label', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'sla_breached', target: 'response', internalNumber: null, orgName: 'Acme' });
    expect(spec.title).toBe('SLA breached (response)');
    expect(spec.body).toBe('Ticket \u00b7 Acme');
    expect(spec.ttl).toBe(14400);
    expect(spec.collapseId).toBe('ticket:t-1:sla:response');
    expect(spec.data).toEqual({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'response' });
  });
  /**
   * REGRESSION (#4281 review, critical): APNs caps `apns-collapse-id` at 64
   * BYTES and answers an over-long value with 400 `BadCollapseId`. Every
   * fixture above uses the 3-character id `t-1`; the real `tickets.id` is a
   * 36-char uuid, which made `ticket:<uuid>:sla_breached:resolution` 67 bytes
   * — so every native-APNs SLA push was rejected while the in-app row and the
   * email still landed. Pin the length with a REAL uuid, not a short fixture.
   */
  it('collapse ids stay inside the 64-byte apns-collapse-id limit for a real uuid ticket id', () => {
    const uuid = '0f5a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
    const specs = [
      buildTicketPush({ ticketId: uuid, reason: 'assigned', internalNumber: 'T-2026-0042', orgName: 'Acme' }),
      buildTicketPush({ ticketId: uuid, reason: 'sla_breached', target: 'response', internalNumber: null, orgName: 'Acme' }),
      buildTicketPush({ ticketId: uuid, reason: 'sla_breached', target: 'resolution', internalNumber: null, orgName: 'Acme' }),
    ];
    for (const spec of specs) {
      expect(Buffer.byteLength(spec.collapseId!, 'utf8')).toBeLessThanOrEqual(64);
    }
    // Shortening must not collapse the two SLA targets onto one another.
    expect(specs[1]!.collapseId).not.toBe(specs[2]!.collapseId);
    expect(specs[0]!.collapseId).not.toBe(specs[1]!.collapseId);
  });
  it('truncates a long org name', () => {
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'x'.repeat(200) });
    expect(spec.body.length).toBeLessThanOrEqual('T-1 \u00b7 '.length + 60);
  });
});

describe('dispatchPushToTokens', () => {
  beforeEach(() => { sendApnsNotificationMock.mockReset(); updateSetCalls.length = 0; });

  it('forwards ttl, collapseId, threadId and category to APNs', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: true, status: 200 });
    const spec = buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' });
    const res = await dispatchPushToTokens([{ token: 'apns-1', platform: 'ios', provider: 'apns' }], spec);
    expect(res).toEqual({ tokensFound: 1, dispatched: 1, errors: 0 });
    expect(sendApnsNotificationMock).toHaveBeenCalledWith('apns-1', expect.objectContaining({
      ttl: 86400, collapseId: 'ticket:t-1:assigned', threadId: 'ticket:t-1', category: 'BREEZE_TICKET',
    }));
  });

  it('purges an unregistered APNs token', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: false, status: 410, unregistered: true });
    await dispatchPushToTokens([{ token: 'dead', platform: 'ios', provider: 'apns' }],
      buildTicketPush({ ticketId: 't-1', reason: 'assigned', internalNumber: 'T-1', orgName: 'Acme' }));
    expect(updateSetCalls).toContainEqual({ apnsToken: null });
  });

  it('approval wrapper output is unchanged', async () => {
    sendApnsNotificationMock.mockResolvedValue({ ok: true, status: 200 });
    await dispatchApprovalPushToTokens([{ token: 'apns-1', platform: 'ios', provider: 'apns' }],
      { approvalId: 'a1', actionLabel: 'Reboot', requestingClientLabel: 'Claude' });
    const [, payload] = sendApnsNotificationMock.mock.calls[0]!;
    expect(payload).toEqual({ title: 'Approval requested', body: 'Claude: Reboot', data: { type: 'approval', approvalId: 'a1' }, ttl: 60 });
  });
});
