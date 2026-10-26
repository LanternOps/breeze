import { describe, expect, it } from 'vitest';
import * as stepUp from './mfaStepUpGrant';

// #10119: every step-up resource digest must fold its uuid ids to lowercase, so
// the mint (POST /auth/mfa/step-up) and the redeeming route agree whatever case
// each side was handed the uuid in. A helper that does not is an unrecoverable
// 403 STEP_UP_REQUIRED on an uppercase uuid.
//
// The helpers are enumerated from the module's own exports rather than listed by
// hand, so a twentieth helper cannot be added without either appearing here or
// failing the first test below.

const LOWER = {
  device: 'abcdef12-3456-4789-8abc-def012345678',
  device2: 'bcdef123-4567-4890-9bcd-ef0123456789',
  org: 'cdef1234-5678-4901-abcd-f01234567890',
  site: 'def12345-6789-4012-bcde-012345678901',
  partner: 'ef123456-789a-4123-cdef-123456789012',
  user: 'f1234567-89ab-4234-def0-234567890123',
  invoice: 'a2345678-9abc-4345-ef01-345678901234',
  snapshot: 'b3456789-abcd-4456-f012-456789012345',
  passkey: 'c456789a-bcde-4567-8123-567890123456',
} as const;

const up = (s: string) => s.toUpperCase();

/**
 * One fixture per helper: `lower` has every uuid in canonical lowercase,
 * `upper` is the same binding with every FOLDED id upper-cased and every
 * non-folded field byte-identical. The two must hash the same.
 *
 * Fields deliberately NOT folded, and so identical in both variants:
 * `reason` and other free text, rollback version strings, `recipientOverride`
 * (an email), `requestedCeilingHash` (a `^[a-f0-9]{64}$` digest, not an id),
 * and `entraTenantId` / `entraOid`, which are `z.string().min(1).max(64)` and
 * never uuid-validated.
 */
type Fixture = readonly [lower: never, upper: never];

const FIXTURES: Record<string, Fixture> = {
  rollbackResourceDigest: [
    { deviceId: LOWER.device, currentVersion: '1.2.3', targetVersion: '1.2.2', reason: 'Bad Release' },
    { deviceId: up(LOWER.device), currentVersion: '1.2.3', targetVersion: '1.2.2', reason: 'Bad Release' },
  ],
  maintenanceResourceDigest: [
    { deviceIds: [LOWER.device, LOWER.device2], reason: 'Planned Window', durationHours: 2 },
    { deviceIds: [up(LOWER.device2), up(LOWER.device)], reason: 'Planned Window', durationHours: 2 },
  ],
  forceRebootResourceDigest: [{ deviceId: LOWER.device }, { deviceId: up(LOWER.device) }],
  moveOrgResourceDigest: [
    { deviceId: LOWER.device, targetOrgId: LOWER.org, targetSiteId: LOWER.site },
    { deviceId: up(LOWER.device), targetOrgId: up(LOWER.org), targetSiteId: up(LOWER.site) },
  ],
  parkedAssignResourceDigest: [
    { deviceId: LOWER.device, targetOrgId: LOWER.org, targetSiteId: LOWER.site },
    { deviceId: up(LOWER.device), targetOrgId: up(LOWER.org), targetSiteId: up(LOWER.site) },
  ],
  parkedBulkAssignResourceDigest: [
    [{ deviceId: LOWER.device, targetOrgId: LOWER.org, targetSiteId: LOWER.site }],
    [{ deviceId: up(LOWER.device), targetOrgId: up(LOWER.org), targetSiteId: up(LOWER.site) }],
  ],
  preAssignmentEnableResourceDigest: [{ partnerId: LOWER.partner }, { partnerId: up(LOWER.partner) }],
  scriptLanePolicyResourceDigest: [
    { orgId: LOWER.org, unattendedEnabled: true },
    { orgId: up(LOWER.org), unattendedEnabled: true },
  ],
  partnerScriptCeilingResourceDigest: [
    { partnerId: LOWER.partner, unattendedAllowed: true },
    { partnerId: up(LOWER.partner), unattendedAllowed: true },
  ],
  topologyArmResourceDigest: [
    { siteId: LOWER.site, action: 'arm_policy', subjectId: LOWER.device },
    { siteId: up(LOWER.site), action: 'arm_policy', subjectId: up(LOWER.device) },
  ],
  unattestedRestoreResourceDigest: [
    { snapshotDbId: LOWER.snapshot, targetDeviceId: LOWER.device, commandType: 'restore_unattested' },
    { snapshotDbId: up(LOWER.snapshot), targetDeviceId: up(LOWER.device), commandType: 'restore_unattested' },
  ],
  autopayChargeNowResourceDigest: [{ invoiceId: LOWER.invoice }, { invoiceId: up(LOWER.invoice) }],
  partnerPaymentSettingsResourceDigest: [
    { partnerId: LOWER.partner, settings: { autopay: true } },
    { partnerId: up(LOWER.partner), settings: { autopay: true } },
  ],
  orgPaymentSettingsResourceDigest: [
    { orgId: LOWER.org, settings: { autopay: true } },
    { orgId: up(LOWER.org), settings: { autopay: true } },
  ],
  migrationWindowOpenResourceDigest: [
    { partnerId: LOWER.partner, principalId: LOWER.user, orgIds: [LOWER.org], endsAt: '2026-10-26T00:00:00.000Z' },
    { partnerId: up(LOWER.partner), principalId: up(LOWER.user), orgIds: [up(LOWER.org)], endsAt: '2026-10-26T00:00:00.000Z' },
  ],
  autopayRequestRecipientResourceDigest: [
    { orgIds: [LOWER.org], recipientOverride: 'Billing@Example.com' },
    { orgIds: [up(LOWER.org)], recipientOverride: 'Billing@Example.com' },
  ],
  callerVerificationAdministrativeDigest: [
    { orgId: LOWER.org, entraTenantId: 'Tenant-ABC', entraOid: 'Oid-XYZ', reason: 'A sufficiently long reason.' },
    { orgId: up(LOWER.org), entraTenantId: 'Tenant-ABC', entraOid: 'Oid-XYZ', reason: 'A sufficiently long reason.' },
  ],
  wispGrantResourceDigest: [
    { grantorUserId: LOWER.user, partnerId: LOWER.partner, orgId: LOWER.org, requestedCeilingHash: 'a'.repeat(64) },
    { grantorUserId: up(LOWER.user), partnerId: up(LOWER.partner), orgId: up(LOWER.org), requestedCeilingHash: 'a'.repeat(64) },
  ],
  passkeyRemovalResourceDigest: [LOWER.passkey, up(LOWER.passkey)],
} as unknown as Record<string, Fixture>;

type DigestFn = (arg: never) => string;

/** The helpers, taken from the module's exports rather than a hand-written list. */
const EXPORTED = Object.entries(stepUp)
  .filter((entry): entry is [string, DigestFn] => entry[0].endsWith('Digest') && typeof entry[1] === 'function')
  .sort(([a], [b]) => (a < b ? -1 : 1));

describe('step-up resource digests fold uuid ids (#10119)', () => {
  it('enumerates every exported digest helper, so a new one cannot skip this suite', () => {
    expect(EXPORTED.length).toBeGreaterThan(0);
    const missing = EXPORTED.map(([name]) => name).filter((name) => !(name in FIXTURES));
    expect(missing, `add a FIXTURES entry for: ${missing.join(', ')}`).toEqual([]);
    // And no stale fixtures for helpers that no longer exist.
    const exported = new Set(EXPORTED.map(([name]) => name));
    expect(Object.keys(FIXTURES).filter((name) => !exported.has(name))).toEqual([]);
  });

  for (const [name, fn] of EXPORTED) {
    it(`${name}: upper-case ids hash the same as canonical lower-case ids`, () => {
      const [lower, upper] = FIXTURES[name];
      expect(fn(upper)).toBe(fn(lower));
    });
  }

  // The generic case above proves the two agree; it cannot prove WHICH way they
  // fold, because an implementation that upper-cased would also make them
  // agree. The literal below pins the direction: lowercase is what Postgres
  // renders from a uuid column, and the routes hash `device.id` straight from
  // there, so folding upward would break every grant minted against a
  // canonical id while keeping this suite green.
  it('folds to lowercase, the spelling Postgres returns', () => {
    expect(
      stepUp.moveOrgResourceDigest({
        deviceId: LOWER.device,
        targetOrgId: LOWER.org,
        targetSiteId: LOWER.site,
      }),
    ).toBe('sha256:cabf6bc9b20491f29db3826b41a279fe34368acddff3890d74a82103726fa7bf');
  });

  // Ordering matters as much as the folding: `[...new Set(ids)].sort()` on raw
  // input keeps two spellings of one device as two entries and sorts uppercase
  // first, so the digest would depend on how the caller typed the ids.
  it('maintenanceResourceDigest dedups case-insensitively, before sorting', () => {
    const oneDeviceTwoSpellings = { deviceIds: [LOWER.device, up(LOWER.device)], reason: 'Planned Window', durationHours: 2 };
    const oneDeviceOnce = { deviceIds: [LOWER.device], reason: 'Planned Window', durationHours: 2 };
    expect(stepUp.maintenanceResourceDigest(oneDeviceTwoSpellings)).toBe(stepUp.maintenanceResourceDigest(oneDeviceOnce));
  });

  it('canonicalId trims and lowercases; canonicalIds dedups and sorts', () => {
    expect(stepUp.canonicalId(`  ${up(LOWER.device)}  `)).toBe(LOWER.device);
    expect(stepUp.canonicalIds([up(LOWER.device2), LOWER.device, LOWER.device2])).toEqual([LOWER.device, LOWER.device2]);
  });
});
