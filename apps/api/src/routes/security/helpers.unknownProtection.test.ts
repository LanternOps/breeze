/**
 * Unknown real-time-protection / firewall state (#8252).
 *
 * Since #8043 ingest stores `security_status.real_time_protection` and
 * `firewall_enabled` as NULL when the agent's collector failed. The fleet
 * security reads must carry that NULL through as "unknown": never coerced to
 * `false` (which painted the device red as Inactive and added the unprotected
 * risk penalty), and never counted as protected either.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { select: vi.fn() },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: {},
  queueCommand: vi.fn(),
}));

vi.mock('../../services/securityPosture', () => ({
  listLatestSecurityPosture: vi.fn(async () => []),
}));

import { db } from '../../db';
import type { AuthContext } from '../../middleware/auth';
import { computePosture, listStatusRows, toStatusResponse } from './helpers';
import type { StatusRow } from './schemas';

const ORG = '11111111-1111-4111-8111-111111111111';

const auth = {
  scope: 'organization',
  orgId: ORG,
  accessibleOrgIds: [ORG],
  allowedSiteIds: undefined,
  orgCondition: () => undefined,
  canAccessOrg: () => true,
} as unknown as AuthContext;

function dbRow(overrides: Record<string, unknown>) {
  return {
    deviceId: 'dev-1',
    orgId: ORG,
    deviceName: 'pc-1',
    os: 'windows',
    deviceState: 'online',
    provider: 'windows_defender',
    providerVersion: null,
    definitionsVersion: null,
    definitionsDate: null,
    realTimeProtection: true,
    threatCount: 0,
    firewallEnabled: true,
    encryptionStatus: 'encrypted',
    encryptionDetails: null,
    localAdminSummary: null,
    passwordPolicySummary: null,
    gatekeeperEnabled: null,
    lastScan: null,
    lastScanType: null,
    ...overrides,
  };
}

function statusRow(overrides: Partial<StatusRow>): StatusRow {
  return {
    ...(dbRow({}) as unknown as StatusRow),
    ...overrides,
  };
}

function mockRows(rows: Record<string, unknown>[]) {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({
      leftJoin: () => ({
        where: () => Promise.resolve(rows),
      }),
    }),
  } as never);
}

describe('listStatusRows — unknown protection state', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps a NULL real-time-protection / firewall reading as null, not false', async () => {
    mockRows([dbRow({ realTimeProtection: null, firewallEnabled: null })]);
    const [row] = await listStatusRows(auth);
    expect(row!.realTimeProtection).toBeNull();
    expect(row!.firewallEnabled).toBeNull();
  });

  it('treats a device with no security_status row as unknown, not off', async () => {
    // LEFT JOIN miss: every security_status column comes back null.
    mockRows([dbRow({ realTimeProtection: null, firewallEnabled: null, threatCount: null, encryptionStatus: null })]);
    const [row] = await listStatusRows(auth);
    expect(row!.realTimeProtection).toBeNull();
    expect(row!.firewallEnabled).toBeNull();
  });

  it('keeps a reported false as false', async () => {
    mockRows([dbRow({ realTimeProtection: false, firewallEnabled: false })]);
    const [row] = await listStatusRows(auth);
    expect(row!.realTimeProtection).toBe(false);
    expect(row!.firewallEnabled).toBe(false);
  });
});

describe('computePosture — unknown protection state', () => {
  it('a fully healthy device is protected', () => {
    expect(computePosture(statusRow({}))).toEqual({ status: 'protected', riskLevel: 'low' });
  });

  it('unknown real-time protection adds no risk penalty but is not claimed as protected', () => {
    expect(computePosture(statusRow({ realTimeProtection: null }))).toEqual({ status: 'at_risk', riskLevel: 'low' });
  });

  it('unknown firewall adds no risk penalty but is not claimed as protected', () => {
    expect(computePosture(statusRow({ firewallEnabled: null }))).toEqual({ status: 'at_risk', riskLevel: 'low' });
  });

  it('a reported-off real-time protection still carries the penalty', () => {
    // false: +2 → at_risk/medium. Unknown must not land in the same bucket.
    expect(computePosture(statusRow({ realTimeProtection: false }))).toEqual({ status: 'at_risk', riskLevel: 'medium' });
  });

  it('unknown does not escalate an otherwise-risky device', () => {
    // unencrypted (+1) with unknown AV + firewall stays medium; if unknown were
    // treated as off it would be +4 → at_risk/high.
    expect(
      computePosture(statusRow({ realTimeProtection: null, firewallEnabled: null, encryptionStatus: 'unencrypted' })),
    ).toEqual({ status: 'at_risk', riskLevel: 'medium' });
  });

  it('offline still wins over unknown', () => {
    expect(computePosture(statusRow({ deviceState: 'offline', realTimeProtection: null }))).toEqual({
      status: 'offline',
      riskLevel: 'medium',
    });
  });
});

describe('toStatusResponse — unknown protection state', () => {
  it('exposes unknown as null on the wire', () => {
    const res = toStatusResponse(statusRow({ realTimeProtection: null, firewallEnabled: null }));
    expect(res.realTimeProtection).toBeNull();
    expect(res.firewallEnabled).toBeNull();
  });
});
