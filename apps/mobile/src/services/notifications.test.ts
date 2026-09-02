import { beforeEach, describe, expect, it, vi } from 'vitest';

// Pure-logic coverage of the token-acquisition branch. Everything RN/Expo is
// mocked with a factory so nothing pulls the React Native runtime into the
// node-only vitest environment (see vitest.config.ts).
// vi.hoisted: these are referenced from vi.mock factories, which are hoisted
// above normal const declarations.
const platform = vi.hoisted(() => ({ OS: 'ios' as 'ios' | 'android' }));
vi.mock('react-native', () => ({ Platform: platform }));

const device = vi.hoisted(() => ({ isDevice: true }));
vi.mock('expo-device', () => ({
  get isDevice() {
    return device.isDevice;
  },
}));

const constants = vi.hoisted(() => ({ expoConfig: { extra: {} } as Record<string, unknown> }));
vi.mock('expo-constants', () => ({ default: constants }));

const notif = vi.hoisted(() => ({
  setNotificationHandler: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  getDevicePushTokenAsync: vi.fn(),
  getExpoPushTokenAsync: vi.fn(),
  setNotificationChannelAsync: vi.fn(),
  getPresentedNotificationsAsync: vi.fn(),
  dismissNotificationAsync: vi.fn(),
  setBadgeCountAsync: vi.fn(),
  AndroidImportance: { MAX: 5 },
}));
vi.mock('expo-notifications', () => notif);

const api = vi.hoisted(() => ({ registerPushToken: vi.fn() }));
vi.mock('./api', () => ({ registerPushToken: (...a: unknown[]) => api.registerPushToken(...a) }));

import {
  registerForPushNotifications,
  reconcileApprovalNotifications,
  reconcilePushRegistration,
  staleApprovalNotificationIds,
  parseApprovalNotification,
  parseTicketData,
  parseTicketNotification,
  parseTimeSuggestionsNotification,
  shouldSetBadgeFor,
} from './notifications';
import {
  notificationsRowCopy,
  pushUnavailableCopy,
} from '../screens/chat/components/pushUnavailableCopy';

beforeEach(() => {
  platform.OS = 'ios';
  device.isDevice = true;
  constants.expoConfig = { extra: {} };
  notif.getPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  notif.requestPermissionsAsync.mockReset().mockResolvedValue({ status: 'granted' });
  notif.getDevicePushTokenAsync.mockReset().mockResolvedValue({ data: 'APNS-TOKEN' });
  notif.getExpoPushTokenAsync.mockReset().mockResolvedValue({ data: 'ExponentPushToken[x]' });
  notif.setNotificationChannelAsync.mockReset().mockResolvedValue(undefined);
  api.registerPushToken.mockReset().mockResolvedValue(undefined);
});

describe('registerForPushNotifications', () => {
  it('iOS uses the NATIVE APNs token, never the Expo relay', async () => {
    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'ok', token: 'APNS-TOKEN' });
    expect(notif.getDevicePushTokenAsync).toHaveBeenCalledTimes(1);
    // The whole point of the native-APNs switch: no Expo account involvement.
    expect(notif.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(api.registerPushToken).toHaveBeenCalledWith('APNS-TOKEN', 'ios');
  });

  it('iOS does not need an EAS projectId', async () => {
    constants.expoConfig = { extra: {} }; // no eas.projectId anywhere
    await expect(registerForPushNotifications()).resolves.toMatchObject({ status: 'ok' });
  });

  it('Android without a projectId reports UNSUPPORTED, not failed', async () => {
    // Regression: this used to throw 'EAS projectId missing', get caught, and
    // surface as status:'failed' — showing a red "push failed" banner for a
    // feature that was never wired after app.json dropped extra.eas.projectId.
    platform.OS = 'android';

    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'unsupported', reason: 'android_push_not_configured' });
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('Android WITH a projectId still uses the Expo relay', async () => {
    platform.OS = 'android';
    constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };

    const out = await registerForPushNotifications();

    expect(out).toEqual({ status: 'ok', token: 'ExponentPushToken[x]' });
    expect(notif.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: 'proj-1' });
    expect(api.registerPushToken).toHaveBeenCalledWith('ExponentPushToken[x]', 'android');
  });

  it('reports unsupported on a simulator', async () => {
    device.isDevice = false;

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'unsupported',
      reason: 'not_physical_device',
    });
  });

  it('emits reasons the Settings sheet maps to SPECIFIC copy, not the generic fallback (#3118)', async () => {
    // Pins the string contract between this service and pushUnavailableCopy:
    // if a reason is renamed here, the sheet silently falls through to generic
    // "this device" copy with both sides' own tests still green.
    platform.OS = 'android';
    const android = await registerForPushNotifications();
    if (android.status !== 'unsupported') throw new Error('expected unsupported');
    expect(pushUnavailableCopy(android.reason).notificationsRow).toMatch(/Android/);

    platform.OS = 'ios';
    device.isDevice = false;
    const sim = await registerForPushNotifications();
    if (sim.status !== 'unsupported') throw new Error('expected unsupported');
    expect(pushUnavailableCopy(sim.reason).notificationsRow).toMatch(/simulator/i);
  });

  it('reports failed when the user denies permission', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    notif.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'failed',
      reason: 'permission_denied',
    });
  });

  it('resolves failed instead of rejecting when the permission check itself throws (#3143)', async () => {
    // Pre-#3143 the permission calls ran before the try/catch, so a throw here
    // became an unhandled rejection in PushRegistrationGate and the store
    // stayed at 'idle' — "Checking push registration…" forever in Settings.
    notif.getPermissionsAsync.mockRejectedValue(new Error('boom'));

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'failed',
      reason: 'boom',
    });
  });

  it('Android channel-setup failure does not reject or flip a registered token to failed (#3143)', async () => {
    // The token is already registered with the API by the time channels are
    // configured; a channel failure is a presentation nit, not a delivery
    // failure. Pre-#3143 this ran after the catch and rejected the promise.
    platform.OS = 'android';
    constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };
    notif.setNotificationChannelAsync.mockRejectedValue(new Error('channel boom'));

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'ok',
      token: 'ExponentPushToken[x]',
    });
  });

  it("permission-denied failure maps to the Settings-actionable row copy (#3143)", async () => {
    // Pins the reason-string contract for the FAILED branch, same as the
    // unsupported pin above: rename 'permission_denied' here and the Settings
    // sheet silently falls back to the generic "sign in again to retry" copy
    // (no Settings deep-link) with both sides' own tests still green.
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied' });
    notif.requestPermissionsAsync.mockResolvedValue({ status: 'denied' });

    const out = await registerForPushNotifications();
    if (out.status !== 'failed') throw new Error('expected failed');
    const copy = notificationsRowCopy(out.status, out.reason);
    expect(copy.opensSystemSettings).toBe(true);
    expect(copy.description).toMatch(/turned off for Breeze in Settings/);
  });

  it('reports failed when the token call throws', async () => {
    notif.getDevicePushTokenAsync.mockRejectedValue(new Error('APNs unavailable'));

    await expect(registerForPushNotifications()).resolves.toEqual({
      status: 'failed',
      reason: 'APNs unavailable',
    });
  });
});

/**
 * A request approved in the web UI leaves its push banner sitting in
 * Notification Center on the phone. Clearing it is the visible half of "the
 * approval dismissed itself"; alert banners must survive the sweep.
 */
function presented(identifier: string, data: Record<string, unknown> | null) {
  return { request: { identifier, content: { data } } };
}

describe('staleApprovalNotificationIds', () => {
  it('selects approval banners whose request is no longer pending', () => {
    const list = [
      presented('n1', { type: 'approval', approvalId: 'a' }),
      presented('n2', { type: 'approval', approvalId: 'b' }),
    ];
    expect(staleApprovalNotificationIds(list, ['b'])).toEqual(['n1']);
  });

  it('never touches alert banners or payload-less notifications', () => {
    const list = [
      presented('n1', { type: 'alert', alertId: 'x', eventType: 'alert.triggered' }),
      presented('n2', null),
      presented('n3', { type: 'approval', approvalId: 'gone' }),
    ];
    expect(staleApprovalNotificationIds(list, [])).toEqual(['n3']);
  });

  it('returns nothing when every delivered approval is still pending', () => {
    const list = [presented('n1', { type: 'approval', approvalId: 'a' })];
    expect(staleApprovalNotificationIds(list, ['a', 'b'])).toEqual([]);
  });
});

describe('reconcileApprovalNotifications', () => {
  beforeEach(() => {
    notif.getPresentedNotificationsAsync.mockReset().mockResolvedValue([]);
    notif.dismissNotificationAsync.mockReset().mockResolvedValue(undefined);
    notif.setBadgeCountAsync.mockReset().mockResolvedValue(undefined);
  });

  it('dismisses resolved approval banners and syncs the badge', async () => {
    notif.getPresentedNotificationsAsync.mockResolvedValue([
      presented('n1', { type: 'approval', approvalId: 'decided-in-browser' }),
      presented('n2', { type: 'approval', approvalId: 'still-waiting' }),
    ]);

    await reconcileApprovalNotifications(['still-waiting']);

    expect(notif.dismissNotificationAsync).toHaveBeenCalledTimes(1);
    expect(notif.dismissNotificationAsync).toHaveBeenCalledWith('n1');
    expect(notif.setBadgeCountAsync).toHaveBeenCalledWith(1);
  });

  it('degrades quietly when the notification APIs throw', async () => {
    notif.getPresentedNotificationsAsync.mockRejectedValue(new Error('no permission'));
    await expect(reconcileApprovalNotifications([])).resolves.toBeUndefined();
  });
});

describe('reconcilePushRegistration (#3143)', () => {
  it("'ok' with permission still granted needs no correction", async () => {
    await expect(reconcilePushRegistration('ok', null)).resolves.toBeNull();
  });

  it("'ok' downgrades to failed/permission_denied when the user revoked permission in Settings", async () => {
    // The exact sequence the Settings sheet's deep-link invites: tap row →
    // system Settings → turn Breeze notifications off → return to the app.
    // iOS does not restart the app, so without this the row keeps claiming
    // "delivered" for the rest of the session.
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(reconcilePushRegistration('ok', null)).resolves.toEqual({
      status: 'failed',
      reason: 'permission_denied',
    });
  });

  it("failed/permission_denied re-registers fully once permission is granted again", async () => {
    const out = await reconcilePushRegistration('failed', 'permission_denied');

    // Not just a status flip: the token must actually be (re)registered.
    expect(out).toEqual({ status: 'ok', token: 'APNS-TOKEN' });
    expect(api.registerPushToken).toHaveBeenCalledWith('APNS-TOKEN', 'ios');
  });

  it('failed/permission_denied stays put while permission remains denied', async () => {
    notif.getPermissionsAsync.mockResolvedValue({ status: 'denied' });

    await expect(reconcilePushRegistration('failed', 'permission_denied')).resolves.toBeNull();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });

  it('non-permission failures and resting states are never touched by a foreground hop', async () => {
    for (const [status, reason] of [
      ['failed', 'some network error'],
      ['failed', null],
      ['unsupported', 'android_push_not_configured'],
      ['idle', null],
    ] as const) {
      await expect(reconcilePushRegistration(status, reason)).resolves.toBeNull();
    }
    expect(notif.getPermissionsAsync).not.toHaveBeenCalled();
    expect(api.registerPushToken).not.toHaveBeenCalled();
  });
});


// ── W06 (#3900): the time-suggestions push parser ──────────────────────────
// W06 ships ONLY the parser. W07 owns the listener wiring, quiet hours and the
// preference category.
function pushWith(data: Record<string, unknown>) {
  return { request: { identifier: 'n1', content: { data } } } as never;
}

describe('parseTimeSuggestionsNotification (#3900)', () => {
  it('accepts the W06 payload shape', () => {
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'time_suggestions', date: '2026-08-29' })))
      .toEqual({ date: '2026-08-29' });
  });

  it('ignores approval and alert pushes', () => {
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'approval', approvalId: 'a1' }))).toBeNull();
    expect(parseTimeSuggestionsNotification(pushWith({ alertId: 'x', eventType: 'alert.triggered' }))).toBeNull();
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'ticket', ticketId: 't1' }))).toBeNull();
  });

  it('ignores a payload without a date — routing to an undated screen is worse than not routing', () => {
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'time_suggestions' }))).toBeNull();
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'time_suggestions', date: 42 }))).toBeNull();
  });

  it('rejects a date that is not YYYY-MM-DD', () => {
    // The screen puts this straight into `?date=`, which the server 400s on a
    // bad shape — better to drop the tap than to open a screen that errors.
    expect(parseTimeSuggestionsNotification(pushWith({ type: 'time_suggestions', date: '29/08/2026' }))).toBeNull();
  });

  it('tolerates a missing data bag', () => {
    expect(parseTimeSuggestionsNotification({ request: { identifier: 'n1', content: {} } } as never)).toBeNull();
  });

  it('parseApprovalNotification still works on the approval payload (no regression)', () => {
    expect(parseApprovalNotification(pushWith({ type: 'approval', approvalId: 'a1' }))).toEqual({ approvalId: 'a1' });
    expect(parseApprovalNotification(pushWith({ type: 'time_suggestions', date: '2026-08-29' }))).toBeNull();
  });
});

// ── W10 (#4336): the ticket push parser ────────────────────────────────────
// Wire contract is `buildTicketPush` in apps/api/src/services/expoPush.ts,
// shipped in the API half (PR #4281): `{ type: 'ticket', ticketId, reason,
// target?, internalNumber? }`.
describe('parseTicketData (#4336)', () => {
  it('parses assigned and sla_breached payloads', () => {
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toEqual({
      ticketId: 't-1',
      reason: 'assigned',
    });
    expect(
      parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'response' })
    ).toEqual({ ticketId: 't-1', reason: 'sla_breached', target: 'response' });
    expect(
      parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'resolution' })
    ).toEqual({ ticketId: 't-1', reason: 'sla_breached', target: 'resolution' });
  });

  it('ignores the server-side presentation extras it does not route on', () => {
    // buildTicketPush also ships `internalNumber` for the lock-screen body.
    // Routing must not depend on it, and its presence must not defeat the parse.
    expect(
      parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'assigned', internalNumber: 'T-42' })
    ).toEqual({ ticketId: 't-1', reason: 'assigned' });
  });

  it('returns null for malformed or non-ticket data', () => {
    expect(parseTicketData(null)).toBeNull();
    expect(parseTicketData(undefined)).toBeNull();
    expect(parseTicketData({ type: 'approval', approvalId: 'a' })).toBeNull();
    expect(parseTicketData({ alertId: 'x', eventType: 'alert.triggered' })).toBeNull();
    expect(parseTicketData({ type: 'ticket' })).toBeNull();
    expect(parseTicketData({ type: 'ticket', ticketId: '', reason: 'assigned' })).toBeNull();
    expect(parseTicketData({ type: 'ticket', ticketId: 42, reason: 'assigned' })).toBeNull();
    expect(parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'bogus' })).toBeNull();
  });

  it('drops an unknown target but keeps the notification', () => {
    // A target the phone does not understand is cosmetic; dropping the whole
    // push would strand the technician on a breach they were told about.
    expect(
      parseTicketData({ type: 'ticket', ticketId: 't-1', reason: 'sla_breached', target: 'x' })
    ).toEqual({ ticketId: 't-1', reason: 'sla_breached' });
  });

  it('parseTicketNotification reads the data bag off a notification', () => {
    expect(parseTicketNotification(pushWith({ type: 'ticket', ticketId: 't-9', reason: 'assigned' }))).toEqual(
      { ticketId: 't-9', reason: 'assigned' }
    );
    expect(parseTicketNotification({ request: { identifier: 'n1', content: {} } } as never)).toBeNull();
  });

  it('the other parsers still reject ticket payloads (no cross-talk)', () => {
    expect(parseApprovalNotification(pushWith({ type: 'ticket', ticketId: 't-1', reason: 'assigned' }))).toBeNull();
    expect(
      parseTimeSuggestionsNotification(pushWith({ type: 'ticket', ticketId: 't-1', reason: 'assigned' }))
    ).toBeNull();
  });
});

describe('shouldSetBadgeFor (#4336)', () => {
  it('is false for ticket pushes and true otherwise (badge stays owned by approvals)', () => {
    // reconcileApprovalNotifications SETS the badge to the pending-approval
    // count. A ticket push that incremented it would be overwritten on the next
    // reconcile anyway — but until then it reads as a phantom approval.
    expect(shouldSetBadgeFor({ type: 'ticket', ticketId: 't-1', reason: 'assigned' })).toBe(false);
    expect(shouldSetBadgeFor({ type: 'approval', approvalId: 'a' })).toBe(true);
    expect(shouldSetBadgeFor({ alertId: 'x', eventType: 'alert.triggered' })).toBe(true);
    expect(shouldSetBadgeFor(undefined)).toBe(true);
    expect(shouldSetBadgeFor(null)).toBe(true);
  });

  it('the registered foreground handler actually consults it', async () => {
    // Asserting the pure function alone would stay green if the handler kept
    // its hard-coded `shouldSetBadge: true`.
    const config = notif.setNotificationHandler.mock.calls[0]?.[0] as {
      handleNotification: (n: unknown) => Promise<{ shouldSetBadge: boolean }>;
    };
    expect(config).toBeDefined();

    await expect(
      config.handleNotification(pushWith({ type: 'ticket', ticketId: 't-1', reason: 'assigned' }))
    ).resolves.toMatchObject({ shouldSetBadge: false, shouldShowBanner: true });
    await expect(
      config.handleNotification(pushWith({ type: 'approval', approvalId: 'a' }))
    ).resolves.toMatchObject({ shouldSetBadge: true });
  });
});

describe('the tickets Android channel (#4336)', () => {
  it('is registered alongside alerts and approvals', async () => {
    platform.OS = 'android';
    constants.expoConfig = { extra: { eas: { projectId: 'proj-1' } } };

    await registerForPushNotifications();

    expect(notif.setNotificationChannelAsync).toHaveBeenCalledWith(
      'tickets',
      expect.objectContaining({ name: 'Tickets' })
    );
  });
});
