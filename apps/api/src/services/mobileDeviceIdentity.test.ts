import { describe, it, expect, vi, beforeEach } from 'vitest';

const limitMock = vi.fn();
vi.mock('../db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: limitMock }) }) }),
  },
}));

vi.mock('../db/schema', () => ({
  mobileDevices: {
    id: { name: 'id' },
    userId: { name: 'user_id' },
    deviceId: { name: 'device_id' },
    status: { name: 'status' },
    fcmToken: { name: 'fcm_token' },
    apnsToken: { name: 'apns_token' },
  },
}));

import { planMobileDeviceId, saltDeviceId } from './mobileDeviceIdentity';

const USER = 'user-owner-1';
const OTHER = 'user-other-2';
const INSTALL = 'install-uuid-aaaa';
const LEGACY = 'push-ios-deadbeef';
const TOKEN = 'apns-token-caller';

/** Queue the rows `planMobileDeviceId` reads, in call order. */
function queueLookups(...rows: Array<unknown[]>) {
  limitMock.mockReset();
  for (const row of rows) limitMock.mockResolvedValueOnce(row);
  limitMock.mockResolvedValue([]);
}

describe('saltDeviceId', () => {
  it('appends a uniquifying suffix', () => {
    expect(saltDeviceId('abc', 1700000000000)).toBe('abc-1700000000000');
  });

  it('truncates so the result still fits varchar(255)', () => {
    // A 255-char base plus a suffix would overflow the column and 500 with
    // 22001 — the /mobile/devices route accepts ids at exactly this length.
    const base = 'x'.repeat(255);
    const salted = saltDeviceId(base, 1700000000000);
    expect(salted.length).toBe(255);
    expect(salted.endsWith('-1700000000000')).toBe(true);
  });
});

describe('planMobileDeviceId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    limitMock.mockResolvedValue([]);
  });

  it('keys on the installation id when the phone has no row yet', async () => {
    queueLookups([], []); // no installation-id row, no legacy row

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({ deviceId: INSTALL, adoptRowId: null, displaceRowId: null, fallbackReason: null });
  });

  it('adopts the existing push-derived row instead of orphaning it', async () => {
    queueLookups(
      [], // nothing on the installation id yet
      [{ id: 'row-legacy', userId: USER, status: 'active', apnsToken: null, fcmToken: null }]
    );

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    // Rewriting in place keeps the uuid PK, so notification prefs and the
    // authenticator_devices FK survive the re-key.
    expect(plan).toEqual({ deviceId: INSTALL, adoptRowId: 'row-legacy', displaceRowId: null, fallbackReason: null });
  });

  it('does NOT adopt a blocked legacy row (no retroactive lockout)', async () => {
    queueLookups([], [{ id: 'row-legacy', userId: USER, status: 'blocked', apnsToken: null, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({ deviceId: INSTALL, adoptRowId: null, displaceRowId: null, fallbackReason: null });
  });

  it('does NOT adopt a legacy row owned by another user', async () => {
    queueLookups([], [{ id: 'row-legacy', userId: OTHER, status: 'active', apnsToken: null, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan.adoptRowId).toBeNull();
    expect(plan.deviceId).toBe(INSTALL);
  });

  it('reuses our own active row under the installation id', async () => {
    queueLookups([{ id: 'row-own', userId: USER, status: 'active', apnsToken: null, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({ deviceId: INSTALL, adoptRowId: null, displaceRowId: null, fallbackReason: null });
  });

  it('salts a fresh id rather than reactivating our own blocked row', async () => {
    queueLookups([{ id: 'row-own', userId: USER, status: 'blocked', apnsToken: null, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan.deviceId).not.toBe(INSTALL);
    expect(plan.deviceId.startsWith(`${INSTALL}-`)).toBe(true);
    expect(plan.adoptRowId).toBeNull();
  });

  it('displaces another user ACTIVE row when the push token proves the same handset', async () => {
    // Same APNs token => the OS minted it for this app install, so the caller
    // really is on the phone that owns the row (colleague signed in after the
    // previous user signed out).
    queueLookups([{ id: 'row-other', userId: OTHER, status: 'active', apnsToken: TOKEN, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({ deviceId: INSTALL, adoptRowId: null, displaceRowId: 'row-other', fallbackReason: null });
  });

  it('refuses to evict another user row on an UNPROVEN installation claim', async () => {
    // The installation id rides in a client-controlled header. Without a
    // matching push token it is a claim, not evidence — a forger who learned
    // the victim's id must not be able to push their row aside.
    queueLookups([{ id: 'row-other', userId: OTHER, status: 'active', apnsToken: 'someone-elses-token', fcmToken: null }], []);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({
      deviceId: LEGACY,
      adoptRowId: null,
      displaceRowId: null,
      fallbackReason: 'unverified-installation-claim',
    });
  });

  it('does not treat a null stored token as a match', async () => {
    queueLookups([{ id: 'row-other', userId: OTHER, status: 'active', apnsToken: null, fcmToken: null }], []);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan.displaceRowId).toBeNull();
    expect(plan.fallbackReason).toBe('unverified-installation-claim');
  });

  it('never disturbs another user BLOCKED row — falls back to push-derived keying', async () => {
    // Moving a blocked row aside would let any account holder clear someone
    // else's lost-phone revocation just by signing in on the device.
    queueLookups([{ id: 'row-other', userId: OTHER, status: 'blocked', apnsToken: null, fcmToken: null }], []);

    const plan = await planMobileDeviceId({ userId: USER, installationId: INSTALL, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({
      deviceId: LEGACY,
      adoptRowId: null,
      displaceRowId: null,
      fallbackReason: 'foreign-blocked-row',
    });
  });

  it('keeps legacy push-derived keying verbatim when no header is present', async () => {
    queueLookups([]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: null, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan).toEqual({ deviceId: LEGACY, adoptRowId: null, displaceRowId: null, fallbackReason: null });
  });

  it('salts the legacy id when the header is absent and our legacy row is blocked', async () => {
    queueLookups([{ id: 'row-legacy', userId: USER, status: 'blocked', apnsToken: null, fcmToken: null }]);

    const plan = await planMobileDeviceId({ userId: USER, installationId: null, legacyDeviceId: LEGACY, platform: 'ios', token: TOKEN });

    expect(plan.deviceId.startsWith(`${LEGACY}-`)).toBe(true);
  });
});
