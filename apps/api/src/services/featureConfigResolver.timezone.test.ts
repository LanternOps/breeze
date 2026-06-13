import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// resolveDeviceTimezone (#1318) must consult the partner timezone, falling
// through explicit -> site -> org -> partner -> UTC. We mock only the `db`
// select chain so the real shared `resolveEffectiveTimezone` precedence runs.

let mockRow: Record<string, unknown> | undefined;

vi.mock('../db', () => {
  const limit = vi.fn(() => Promise.resolve(mockRow ? [mockRow] : []));
  const where = vi.fn(() => ({ limit }));
  const leftJoin = vi.fn(() => ({ where }));
  const innerJoin2 = vi.fn(() => ({ leftJoin }));
  const innerJoin1 = vi.fn(() => ({ innerJoin: innerJoin2 }));
  const from = vi.fn(() => ({ innerJoin: innerJoin1 }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } };
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
