import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../db';
import { organizations, partners } from '../db/schema';
import { mlFeatureGloballyDisabled } from '../config/env';

export const ML_FEATURE_FLAGS = [
  'ml.alert_correlation.enabled',
  'ml.rca.enabled',
  'ml.metric_rollups.enabled',
  'ml.anomalies.enabled',
  'ml.anomalies.create_alerts',
  'ml.remediation_suggestions.enabled',
  'ml.ticket_triage.enabled',
  'ml.user_risk_v0.enabled',
  'ml.user_risk_v1.enabled',
] as const;

export type MlFeatureFlagName = (typeof ML_FEATURE_FLAGS)[number];

export type MlFeatureFlagSource =
  | 'global_kill_switch'
  | 'org_settings'
  | 'partner_settings'
  | 'default'
  | 'org_not_found';

export interface MlFeatureFlagDefaultContext {
  nodeEnv?: string | null;
  orgType?: string | null;
  partnerType?: string | null;
}

export interface MlFeatureFlagResolution {
  flag: MlFeatureFlagName;
  enabled: boolean;
  defaultEnabled: boolean;
  source: MlFeatureFlagSource;
}

interface MlFeatureFlagSettingsContext extends MlFeatureFlagDefaultContext {
  orgSettings?: unknown;
  partnerSettings?: unknown;
}

const ML_FEATURE_FLAG_SET = new Set<string>(ML_FEATURE_FLAGS);

export function isMlFeatureFlagName(flag: string): flag is MlFeatureFlagName {
  return ML_FEATURE_FLAG_SET.has(flag);
}

export function assertMlFeatureFlagName(flag: string): asserts flag is MlFeatureFlagName {
  if (!isMlFeatureFlagName(flag)) {
    throw new Error(`Unknown ML feature flag: ${flag}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function lookupPath(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (!(segment in record)) return undefined;
    current = record[segment];
  }
  return current;
}

function flagOverrideFromSettings(settings: unknown, flag: MlFeatureFlagName): boolean | undefined {
  const root = asRecord(settings);
  const ml = asRecord(root.ml);
  const flatContainers = [
    root,
    asRecord(root.mlFeatureFlags),
    asRecord(root.featureFlags),
    asRecord(ml.featureFlags),
    asRecord(ml.flags),
  ];

  for (const container of flatContainers) {
    const value = booleanValue(container[flag]);
    if (value !== undefined) return value;
  }

  const nestedPath = flag.replace(/^ml\./, '').split('.');
  return booleanValue(lookupPath(ml, nestedPath));
}

export function defaultMlFeatureFlagValue(
  flag: MlFeatureFlagName,
  context: MlFeatureFlagDefaultContext = {},
): boolean {
  assertMlFeatureFlagName(flag);

  if (flag === 'ml.metric_rollups.enabled' || flag === 'ml.user_risk_v0.enabled') {
    return true;
  }

  if (flag === 'ml.alert_correlation.enabled') {
    if (context.orgType === 'internal' || context.partnerType === 'internal') return true;
    return (context.nodeEnv ?? process.env.NODE_ENV ?? 'development') !== 'production';
  }

  return false;
}

export function resolveMlFeatureFlag(
  flag: MlFeatureFlagName,
  context: MlFeatureFlagSettingsContext = {},
): MlFeatureFlagResolution {
  assertMlFeatureFlagName(flag);

  const defaultEnabled = defaultMlFeatureFlagValue(flag, context);
  const partnerOverride = flagOverrideFromSettings(context.partnerSettings, flag);
  const orgOverride = flagOverrideFromSettings(context.orgSettings, flag);

  let enabled = defaultEnabled;
  let source: MlFeatureFlagSource = 'default';

  if (partnerOverride !== undefined) {
    enabled = partnerOverride;
    source = 'partner_settings';
  }

  if (orgOverride !== undefined) {
    enabled = orgOverride;
    source = 'org_settings';
  }

  if (mlFeatureGloballyDisabled(flag)) {
    return { flag, enabled: false, defaultEnabled, source: 'global_kill_switch' };
  }

  return { flag, enabled, defaultEnabled, source };
}

export async function resolveMlFeatureFlagForOrg(
  orgId: string,
  flag: MlFeatureFlagName,
): Promise<MlFeatureFlagResolution> {
  assertMlFeatureFlagName(flag);

  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .select({
        orgSettings: organizations.settings,
        orgType: organizations.type,
        partnerSettings: partners.settings,
        partnerType: partners.type,
      })
      .from(organizations)
      .innerJoin(partners, eq(organizations.partnerId, partners.id))
      .where(eq(organizations.id, orgId))
      .limit(1);

    if (!row) {
      const defaultEnabled = defaultMlFeatureFlagValue(flag);
      return { flag, enabled: false, defaultEnabled, source: 'org_not_found' };
    }

    return resolveMlFeatureFlag(flag, {
      orgSettings: row.orgSettings,
      orgType: row.orgType,
      partnerSettings: row.partnerSettings,
      partnerType: row.partnerType,
    });
  });
}

export async function isMlFeatureEnabledForOrg(
  orgId: string,
  flag: MlFeatureFlagName,
): Promise<boolean> {
  return (await resolveMlFeatureFlagForOrg(orgId, flag)).enabled;
}

export async function shouldProduceMlOutput(
  orgId: string,
  flag: MlFeatureFlagName,
): Promise<boolean> {
  return isMlFeatureEnabledForOrg(orgId, flag);
}

export async function resolveAllMlFeatureFlagsForOrg(
  orgId: string,
): Promise<Record<MlFeatureFlagName, MlFeatureFlagResolution>> {
  const entries = await Promise.all(
    ML_FEATURE_FLAGS.map(async (flag) => [flag, await resolveMlFeatureFlagForOrg(orgId, flag)] as const),
  );
  return Object.fromEntries(entries) as Record<MlFeatureFlagName, MlFeatureFlagResolution>;
}
