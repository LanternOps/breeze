import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { dbSelect, withSystemDbAccessContext } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// `resolveMlFeatureFlagForOrg` now escapes to a system context through
// `readWithPartnerAxisVisibility` (#2822) rather than calling
// `withSystemDbAccessContext` directly — which was a no-op inside a request.
// The hoisted spy stays wired so the existing "runs in a system context"
// assertions keep exercising the real call, and the two new exports the helper
// needs are added as pass-throughs.
vi.mock('../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => undefined),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  db: { select: dbSelect },
  withSystemDbAccessContext,
}));

vi.mock('../db/schema', () => ({
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
    settings: 'organizations.settings',
    type: 'organizations.type',
  },
  partners: {
    id: 'partners.id',
    settings: 'partners.settings',
    type: 'partners.type',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((left, right) => ({ eq: [left, right] })),
}));

import {
  assertMlFeatureFlagName,
  defaultMlFeatureFlagValue,
  isMlFeatureEnabledForOrg,
  resolveMlFeatureFlag,
  resolveMlFeatureFlagForOrg,
} from './mlFeatureFlags';

const ORIGINAL_ENV = { ...process.env };

/**
 * `resolveMlFeatureFlagForOrg` issues TWO queries (#2822): the `organizations`
 * read stays in the CALLER'S context so RLS still decides which org resolves,
 * and only the partner-axis `partners` read is escaped to a system context.
 * (Escaping the old `organizations INNER JOIN partners` wholesale would have
 * made any org id selectable system-wide for a caller-supplied `?orgId=`.)
 *
 * The fixture keeps the original single-row shape and this helper fans it out
 * across the two calls, so the existing cases read unchanged.
 */
function mockOrgSettingsRow(row: (Record<string, unknown>) | null) {
  // 1. organizations — caller context.
  dbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue(
          row
            ? [{ settings: row.orgSettings, type: row.orgType, partnerId: 'partner-1' }]
            : []
        ),
      })),
    })),
  } as any);

  if (!row) return; // no org => the partner read is never issued

  // 2. partners — inside readWithPartnerAxisVisibility.
  dbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn().mockResolvedValue([
          { settings: row.partnerSettings, type: row.partnerType },
        ]),
      })),
    })),
  } as any);
}

describe('mlFeatureFlags', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.ML_FEATURES_DISABLED;
    delete process.env.ML_OUTPUTS_DISABLED;
    delete process.env.ML_GLOBAL_KILL_SWITCH;
    delete process.env.ML_DISABLED_FLAGS;
    delete process.env.ML_RCA_DISABLED;
    delete process.env.ML_ALERT_CORRELATION_DISABLED;
    delete process.env.ML_DEVICE_RELIABILITY_DISABLED;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('uses conservative production defaults and enables dev/internal wedge flags', () => {
    expect(defaultMlFeatureFlagValue('ml.alert_correlation.enabled', {
      nodeEnv: 'production',
      orgType: 'customer',
      partnerType: 'msp',
    })).toBe(false);
    expect(defaultMlFeatureFlagValue('ml.alert_correlation.enabled', {
      nodeEnv: 'development',
      orgType: 'customer',
      partnerType: 'msp',
    })).toBe(true);
    expect(defaultMlFeatureFlagValue('ml.alert_correlation.enabled', {
      nodeEnv: 'production',
      orgType: 'customer',
      partnerType: 'internal',
    })).toBe(true);
    expect(defaultMlFeatureFlagValue('ml.metric_rollups.enabled', { nodeEnv: 'production' })).toBe(true);
    expect(defaultMlFeatureFlagValue('ml.device_reliability.enabled', { nodeEnv: 'production' })).toBe(true);
    expect(defaultMlFeatureFlagValue('ml.user_risk_v0.enabled', { nodeEnv: 'production' })).toBe(true);
    expect(defaultMlFeatureFlagValue('ml.anomalies.v1_shadow.enabled', { nodeEnv: 'production' })).toBe(false);
    expect(defaultMlFeatureFlagValue('ml.rca.enabled', { nodeEnv: 'production' })).toBe(false);
  });

  it('lets org settings override partner/default settings', () => {
    const enabled = resolveMlFeatureFlag('ml.rca.enabled', {
      nodeEnv: 'production',
      partnerSettings: { mlFeatureFlags: { 'ml.rca.enabled': false } },
      orgSettings: { mlFeatureFlags: { 'ml.rca.enabled': true } },
    });

    expect(enabled).toMatchObject({
      flag: 'ml.rca.enabled',
      enabled: true,
      source: 'org_settings',
    });

    const disabled = resolveMlFeatureFlag('ml.metric_rollups.enabled', {
      orgSettings: { ml: { metric_rollups: { enabled: false } } },
    });

    expect(disabled).toMatchObject({
      enabled: false,
      defaultEnabled: true,
      source: 'org_settings',
    });
  });

  it('resolves org overrides through existing org and partner settings columns', async () => {
    mockOrgSettingsRow({
      orgSettings: { mlFeatureFlags: { 'ml.ticket_triage.enabled': true } },
      orgType: 'customer',
      partnerSettings: {},
      partnerType: 'msp',
    });

    const resolution = await resolveMlFeatureFlagForOrg('org-1', 'ml.ticket_triage.enabled');

    expect(resolution).toMatchObject({
      enabled: true,
      source: 'org_settings',
    });
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('global kill switches suppress enabled flags before producers write outputs', async () => {
    process.env.ML_RCA_DISABLED = 'true';
    mockOrgSettingsRow({
      orgSettings: { mlFeatureFlags: { 'ml.rca.enabled': true } },
      orgType: 'customer',
      partnerSettings: {},
      partnerType: 'msp',
    });

    await expect(isMlFeatureEnabledForOrg('org-1', 'ml.rca.enabled')).resolves.toBe(false);

    const direct = resolveMlFeatureFlag('ml.alert_correlation.enabled', {
      nodeEnv: 'development',
      orgSettings: { mlFeatureFlags: { 'ml.alert_correlation.enabled': true } },
    });
    expect(direct.enabled).toBe(true);

    process.env.ML_FEATURES_DISABLED = 'true';
    expect(resolveMlFeatureFlag('ml.alert_correlation.enabled', {
      nodeEnv: 'development',
      orgSettings: { mlFeatureFlags: { 'ml.alert_correlation.enabled': true } },
    })).toMatchObject({
      enabled: false,
      source: 'global_kill_switch',
    });

    process.env.ML_FEATURES_DISABLED = 'false';
    process.env.ML_DISABLED_FLAGS = 'ml.anomalies.*';
    expect(resolveMlFeatureFlag('ml.anomalies.enabled', {
      orgSettings: { mlFeatureFlags: { 'ml.anomalies.enabled': true } },
    })).toMatchObject({
      enabled: false,
      source: 'global_kill_switch',
    });

    process.env.ML_DISABLED_FLAGS = '';
    process.env.ML_DEVICE_RELIABILITY_DISABLED = 'true';
    expect(resolveMlFeatureFlag('ml.device_reliability.enabled')).toMatchObject({
      enabled: false,
      defaultEnabled: true,
      source: 'global_kill_switch',
    });
  });

  it('rejects unknown flag names at runtime', () => {
    expect(() => assertMlFeatureFlagName('ml.unknown.enabled')).toThrow('Unknown ML feature flag');
    expect(() => resolveMlFeatureFlag('ml.unknown.enabled' as never)).toThrow('Unknown ML feature flag');
  });

  it('fails closed when the org is missing', async () => {
    mockOrgSettingsRow(null);

    await expect(resolveMlFeatureFlagForOrg('missing-org', 'ml.metric_rollups.enabled')).resolves.toMatchObject({
      enabled: false,
      source: 'org_not_found',
      defaultEnabled: true,
    });
  });
});
