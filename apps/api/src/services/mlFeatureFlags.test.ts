import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const { dbSelect, withSystemDbAccessContext } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db', () => ({
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

function mockOrgSettingsRow(row: unknown | null) {
  dbSelect.mockReturnValueOnce({
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(row ? [row] : []),
        })),
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
