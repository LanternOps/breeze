import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resolveDeviceTimezone (#1318) must consult the partner timezone, falling
// through explicit -> site -> org -> partner -> UTC. We mock only the `db`
// select chain so the real shared `resolveEffectiveTimezone` precedence runs.

let mockRow: Record<string, unknown> | undefined;

// resolveDeviceTimezone issues TWO queries (#2822), and the split is the point:
//   1. from(devices).innerJoin(organizations).leftJoin(sites).where().limit(1)
//      — runs in the CALLER'S context, so RLS still decides which device is
//        legible. Escaping this half too would demote device isolation on the
//        backup/patch paths to app-layer-only.
//   2. from(partners).where(id = org.partnerId).limit(1)
//      — runs inside readWithPartnerAxisVisibility, because `partners` is
//        partner-axis and an org-scoped caller has accessiblePartnerIds = [].
//        Previously this was a leftJoin in query 1, which kept the device row
//        alive but left the partner COLUMNS null — the silent fall-through to
//        site -> org -> 'UTC' that #2822 fixes.
//
// The mock dispatches on the table handed to `.from()` rather than on call
// order, so it stays correct if the two reads are ever reordered.
//
// The db-context helpers are pass-throughs here — this suite asserts the
// precedence chain, not the RLS escape; the escape is proved against real
// Postgres in __tests__/integration/partnerAxisSystemContext.integration.test.ts.
vi.mock('../db', () => {
  const deviceLimit = vi.fn(() =>
    Promise.resolve(
      mockRow
        ? [{
          siteTimezone: mockRow.siteTimezone,
          orgSettings: mockRow.orgSettings,
          partnerId: mockRow.partnerId ?? 'partner-1',
        }]
        : []
    )
  );
  // `partnerTimezone: null` + `partnerSettings: null` models "no partner row"
  // (deleted, or — pre-fix — RLS-invisible).
  const partnerLimit = vi.fn(() =>
    Promise.resolve(
      mockRow && !(mockRow.partnerTimezone == null && mockRow.partnerSettings == null)
        ? [{ timezone: mockRow.partnerTimezone, settings: mockRow.partnerSettings }]
        : []
    )
  );

  const select = vi.fn(() => ({
    from: vi.fn((table: { id?: string } | undefined) =>
      table?.id === 'partners.id'
        ? { where: vi.fn(() => ({ limit: partnerLimit })) }
        : {
          innerJoin: vi.fn(() => ({
            leftJoin: vi.fn(() => ({ where: vi.fn(() => ({ limit: deviceLimit })) })),
          })),
        }
    ),
  }));

  return {
    db: { select },
    getCurrentDbAccessContext: vi.fn(() => undefined),
    runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
    withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  };
});

// The resolver imports many schema tables; a thin stub keeps the module load
// cheap without pulling the full Drizzle schema graph into the test.
vi.mock('../db/schema', () => ({
  configurationPolicies: {},
  configPolicyFeatureLinks: {},
  configPolicyAssignments: {},
  configPolicyAlertRules: {},
  configPolicyAutomations: {},
  configPolicyComplianceRules: {},
  configPolicyPatchSettings: {},
  configPolicyMaintenanceSettings: {},
  configPolicyBackupSettings: {},
  configPolicySensitiveDataSettings: {},
  devices: { id: 'devices.id', orgId: 'devices.orgId', siteId: 'devices.siteId' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', settings: 'organizations.settings' },
  partners: { id: 'partners.id', timezone: 'partners.timezone', settings: 'partners.settings' },
  deviceGroupMemberships: {},
  sites: { id: 'sites.id', timezone: 'sites.timezone' },
  softwarePolicies: {},
}));

import { resolveDeviceTimezone } from './featureConfigResolver';

describe('resolveDeviceTimezone (#1318 partner fallback)', () => {
  beforeEach(() => {
    mockRow = undefined;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('prefers the site timezone when set', async () => {
    mockRow = {
      siteTimezone: 'America/Chicago',
      orgSettings: { timezone: 'America/Denver' },
      partnerTimezone: 'America/Los_Angeles',
      partnerSettings: {},
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('America/Chicago');
  });

  it('falls back to the org timezone when site is unset', async () => {
    mockRow = {
      siteTimezone: null,
      orgSettings: { timezone: 'America/Denver' },
      partnerTimezone: 'America/Los_Angeles',
      partnerSettings: {},
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('America/Denver');
  });

  it('falls back to the partner column when site and org are unset', async () => {
    mockRow = {
      siteTimezone: null,
      orgSettings: {},
      partnerTimezone: 'Europe/London',
      partnerSettings: {},
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('Europe/London');
  });

  it('reads the legacy partner settings.timezone key when the column is still default UTC', async () => {
    mockRow = {
      siteTimezone: null,
      orgSettings: {},
      partnerTimezone: 'UTC',
      partnerSettings: { timezone: 'Asia/Tokyo' },
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('Asia/Tokyo');
  });

  it('treats a non-canonical lowercase utc column as the default and consults the legacy settings key', async () => {
    mockRow = {
      siteTimezone: null,
      orgSettings: {},
      partnerTimezone: 'utc',
      partnerSettings: { timezone: 'Asia/Tokyo' },
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('Asia/Tokyo');
  });

  it('no partner row: still resolves the org tz, not UTC', async () => {
    // A missing partner row (deleted tenant, or — pre-#2822 — an RLS-invisible
    // one) must leave the device row intact and resolve through site -> org.
    // The partner read is a SEPARATE query now, so its absence can no longer
    // drop the device row at all; this pins that the fall-through still works.
    mockRow = {
      siteTimezone: null,
      orgSettings: { timezone: 'America/Denver' },
      partnerTimezone: null,
      partnerSettings: null,
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('America/Denver');
  });

  it('no partner row: still resolves the site tz, not UTC', async () => {
    mockRow = {
      siteTimezone: 'America/Chicago',
      orgSettings: {},
      partnerTimezone: null,
      partnerSettings: null,
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('America/Chicago');
  });

  it('returns UTC as the last resort when nothing resolves', async () => {
    mockRow = {
      siteTimezone: null,
      orgSettings: {},
      partnerTimezone: 'UTC',
      partnerSettings: {},
    };
    expect(await resolveDeviceTimezone('dev-1')).toBe('UTC');
  });

  it('returns UTC when the device row is missing', async () => {
    mockRow = undefined;
    expect(await resolveDeviceTimezone('missing')).toBe('UTC');
  });
});
