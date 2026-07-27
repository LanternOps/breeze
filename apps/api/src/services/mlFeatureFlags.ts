import { eq } from 'drizzle-orm';
import { db } from '../db';
import { readWithPartnerAxisVisibility } from '../db/partnerAxisRead';
import { organizations, partners } from '../db/schema';
import { mlFeatureGloballyDisabled } from '../config/env';

export const ML_FEATURE_FLAGS = [
  'ml.alert_correlation.enabled',
  'ml.rca.enabled',
  'ml.metric_rollups.enabled',
  'ml.anomalies.enabled',
  'ml.anomalies.v1_shadow.enabled',
  'ml.anomalies.create_alerts',
  'ml.remediation_suggestions.enabled',
  'ml.ticket_triage.enabled',
  'ml.device_reliability.enabled',
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

  if (
    flag === 'ml.metric_rollups.enabled'
    || flag === 'ml.device_reliability.enabled'
    || flag === 'ml.user_risk_v0.enabled'
  ) {
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

/**
 * The org + partner settings `resolveMlFeatureFlag` needs, or null when either
 * row is unreadable.
 *
 * TWO queries, deliberately split (#2822):
 *  - `organizations` runs in the CALLER'S context, so RLS still decides which
 *    org is legible. This matters because `GET /config/ml-feature-flags` takes
 *    a caller-supplied `?orgId=`; escaping the old
 *    `organizations INNER JOIN partners` wholesale would have made ANY org id
 *    selectable and demoted this path to app-layer-only isolation, which
 *    CLAUDE.md forbids.
 *  - `partners` is partner-axis, so it needs the system escape: an org-scoped
 *    caller has accessiblePartnerIds = [], the row came back empty, the old
 *    innerJoin erased the ENTIRE result row, and every ML feature was reported
 *    as `{ enabled: false, source: 'org_not_found' }` — false on both counts.
 *    (`withSystemDbAccessContext` alone was a no-op here: inside a request it
 *    early-returns and inherits the caller's context.)
 *
 * Factored out so `resolveAllMlFeatureFlagsForOrg` can pay for it ONCE.
 */
async function loadMlFlagInputs(orgId: string): Promise<{
  orgSettings: unknown;
  orgType: string | null;
  partnerSettings: unknown;
  partnerType: string | null;
} | null> {
  const [org] = await db
    .select({ settings: organizations.settings, type: organizations.type, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) return null;

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings, type: partners.type })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .limit(1)
  );

  // Preserves the old innerJoin semantics: no partner row => no result at all,
  // rather than silently resolving against partner defaults.
  if (!partner) return null;

  return {
    orgSettings: org.settings,
    orgType: org.type,
    partnerSettings: partner.settings,
    partnerType: partner.type,
  };
}

export async function resolveMlFeatureFlagForOrg(
  orgId: string,
  flag: MlFeatureFlagName,
): Promise<MlFeatureFlagResolution> {
  assertMlFeatureFlagName(flag);

  const inputs = await loadMlFlagInputs(orgId);
  if (!inputs) {
    const defaultEnabled = defaultMlFeatureFlagValue(flag);
    return { flag, enabled: false, defaultEnabled, source: 'org_not_found' };
  }

  return resolveMlFeatureFlag(flag, inputs);
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
  // TWO queries total, not 2 per flag (#2822 review). `resolveMlFeatureFlag` is
  // pure — given the org/partner settings it touches no DB — so the 11
  // ML_FEATURE_FLAGS share one `loadMlFlagInputs` call.
  //
  // This also removes the need for a system context around the fan-out.
  // Resolving each flag independently would have taken 11 partner-axis escapes,
  // and under `Promise.all` those are 11 SIMULTANEOUS `baseDb.transaction`s —
  // 11 pooled connections on top of the request's own — for a single
  // `GET /config/ml-feature-flags`. Against the 25-connection ceiling that is a
  // self-deadlock, not a slowdown: postgres-js has no acquire timeout, so the
  // requests hang rather than error (#1105 class). Hoisting one shared context
  // would have fixed the count but system-scoped the org read too; loading the
  // inputs once fixes both, and keeps the org read under RLS.
  const inputs = await loadMlFlagInputs(orgId);

  const entries = ML_FEATURE_FLAGS.map((flag) => [
    flag,
    inputs
      ? resolveMlFeatureFlag(flag, inputs)
      : {
        flag,
        enabled: false,
        defaultEnabled: defaultMlFeatureFlagValue(flag),
        source: 'org_not_found' as const,
      },
  ] as const);

  return Object.fromEntries(entries) as Record<MlFeatureFlagName, MlFeatureFlagResolution>;
}
