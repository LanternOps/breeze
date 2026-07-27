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

export async function resolveMlFeatureFlagForOrg(
  orgId: string,
  flag: MlFeatureFlagName,
): Promise<MlFeatureFlagResolution> {
  assertMlFeatureFlagName(flag);

  // `withSystemDbAccessContext` alone was a NO-OP here (#2822): inside a request
  // it early-returns and inherits the caller's context. `GET /config/ml-feature-flags`
  // and routes/alerts/correlations.ts are requireScope('organization',…), so an
  // org-scoped caller (accessiblePartnerIds = []) hit an innerJoin on the
  // partner-axis `partners` table — the invisible partner row erased the ENTIRE
  // result row, and the function reported every ML feature as
  // `{ enabled: false, source: 'org_not_found' }`, a statement that is false on
  // both counts.
  //
  // The org read stays in the CALLER'S context and the partner read is escaped
  // separately (the split `effectiveSettings.ts` already uses). Escaping the
  // whole `organizations INNER JOIN partners` instead would make the ORG row
  // selectable system-wide, demoting org isolation on this path to app-layer-only
  // — which CLAUDE.md forbids — for a caller-supplied `?orgId=`. RLS must stay
  // the thing that decides WHICH org resolves; the escape only makes the
  // partner's COLUMNS legible.
  const [org] = await db
    .select({ settings: organizations.settings, type: organizations.type, partnerId: organizations.partnerId })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);

  if (!org) {
    const defaultEnabled = defaultMlFeatureFlagValue(flag);
    return { flag, enabled: false, defaultEnabled, source: 'org_not_found' };
  }

  const [partner] = await readWithPartnerAxisVisibility(() =>
    db
      .select({ settings: partners.settings, type: partners.type })
      .from(partners)
      .where(eq(partners.id, org.partnerId))
      .limit(1)
  );

  // Preserves the old innerJoin semantics: no partner row => treat as
  // org_not_found rather than silently resolving against partner defaults.
  if (!partner) {
    const defaultEnabled = defaultMlFeatureFlagValue(flag);
    return { flag, enabled: false, defaultEnabled, source: 'org_not_found' };
  }

  return resolveMlFeatureFlag(flag, {
    orgSettings: org.settings,
    orgType: org.type,
    partnerSettings: partner.settings,
    partnerType: partner.type,
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
  // ONE system context for the whole fan-out (#2822 review). There are 11
  // ML_FEATURE_FLAGS and this resolves them concurrently, so leaving each
  // `resolveMlFeatureFlagForOrg` to take its own partner-axis escape would open
  // 11 SIMULTANEOUS `baseDb.transaction`s — 11 pooled connections — on top of
  // the request's own held connection, for a single
  // `GET /config/ml-feature-flags`. Against the 25-connection ceiling that is a
  // self-deadlock: postgres-js has no acquire timeout, so the requests hang
  // rather than error (#1105 class). Entering once here makes every nested
  // escape observe `scope === 'system'` and take its skip branch, so the whole
  // fan-out costs exactly one extra connection.
  //
  // The org read inside each resolver is then system-scoped too. That is safe
  // ONLY because this function takes a single `orgId` that its callers have
  // already gated (routes/config.ts checks `auth.canAccessOrg`) — it is not a
  // per-flag widening. Callers that resolve a single flag keep the org read
  // under RLS.
  const entries = await readWithPartnerAxisVisibility(() =>
    Promise.all(
      ML_FEATURE_FLAGS.map(async (flag) => [flag, await resolveMlFeatureFlagForOrg(orgId, flag)] as const),
    ),
  );
  return Object.fromEntries(entries) as Record<MlFeatureFlagName, MlFeatureFlagResolution>;
}
