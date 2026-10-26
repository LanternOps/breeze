/**
 * Server-side half of the partner settings catalog (#9170, spec §5.2, §5.6).
 *
 * For each catalog entry: where an org's own value is stored (`orgSource`),
 * how it may leave the server (`project`), and the count predicates
 * (`bucketSql`). `bucketSql` is the ONLY place a count predicate is defined:
 * the tab aggregate wraps it in `COUNT(*) FILTER (WHERE …)` and the drill-down
 * applies it before its keyset LIMIT.
 *
 * Every "has its own value" predicate mirrors what the runtime resolver treats
 * as set (presence, validity, truthiness or non-blank, per resolver), and
 * `hasOwnValue` is its TypeScript mirror. Whether an org's own value is in
 * effect is decided by calling the runtime resolver itself
 * (`orgValueInEffect`), never by re-deriving its precedence here. The
 * integration contract test proves the SQL and the resolvers agree.
 *
 * SQL hygiene: JSON paths are literal arrays defined in this file and reach SQL
 * only as a bound `text[]` (`settings #> $n::text[]`); channel config keys and
 * partner values are bound parameters. No catalog id, path segment or request
 * value is ever interpolated into SQL text.
 */
import { isDeepStrictEqual } from 'node:util';
import { sql, type SQL } from 'drizzle-orm';
import {
  AI_APPROVAL_TIMEOUT_MAX_MINUTES,
  AI_APPROVAL_TIMEOUT_MIN_MINUTES,
  PARTNER_SETTINGS_CATALOG,
  resolveAiApprovalTimeout,
  resolveEnrollmentDefaults,
  resolveInheritedAgentVersionPins,
  type CatalogEntry,
} from '@breeze/shared';
import { organizations } from '../../db/schema/orgs';
import { aiBudgets } from '../../db/schema/ai';
import { portalBranding } from '../../db/schema/portal';
import { notificationChannelConfigs } from '../../db/schema/alerts';
import { resolveForwardingDestination } from '../logForwarding';
import {
  resolveEffectiveAiBudgetFromRows,
  resolveEffectiveCategorySettings,
  type AiBudgetRow,
} from '../effectiveSettings';
import { resolveAgentUpdateConfig } from '../agentUpdateConfig';
import { applyPartnerPushoverDefaults, type PartnerPushoverDefaults } from '../partnerPushoverDefaults';
import type { PushoverConfig } from '../notificationSenders';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AiBudgetColumn = keyof AiBudgetRow & keyof typeof aiBudgets.$inferSelect;
export type PortalBrandingColumn = 'logoUrl' | 'primaryColor';
/** Keys of a Pushover channel config that partner defaults fill when blank. */
export type PushoverConfigKey = 'token' | 'user' | 'sound' | 'priority';

export type OrgSource =
  | { kind: 'orgSettings'; path: readonly string[] } // organizations.settings #> path
  | { kind: 'aiBudgets'; column: AiBudgetColumn } // one ai_budgets row per org
  | { kind: 'portalBranding'; column: PortalBrandingColumn } // one portal_branding row per org
  | { kind: 'pushoverChannels'; key: PushoverConfigKey } // config -> key, per org Pushover channel
  | null;

export type OrgSourceKind = NonNullable<OrgSource>['kind'];

export const BUCKETS = Object.freeze(['ownValue', 'overrides', 'shadowed', 'clamped'] as const);
export type Bucket = (typeof BUCKETS)[number];

export interface FieldBinding {
  id: string;
  orgSource: OrgSource;
  /** Non-secret projection of an org's own value; undefined for presence-only. */
  project(raw: unknown): unknown;
  /** TypeScript mirror of the SQL own-value predicate (per channel for Pushover). */
  hasOwnValue(raw: unknown): boolean;
  /**
   * FILTER predicate for one count, evaluated per org row (per channel row for
   * Pushover). `null`: the bucket does not apply to this field, or is not
   * computable (overrides on a secret field).
   */
  bucketSql(bucket: Bucket, partnerSettings: unknown): SQL | null;
  /** The org-side expression a drill-down selects for classification; null without an org source. */
  valueSql: SQL | null;
  /** The partner has stored a value the resolver treats as set. */
  partnerSet(partnerSettings: unknown): boolean;
  /** The partner value is in force now. */
  inForce(partnerSettings: unknown): boolean;
  /** Runtime resolver: is this org's own value what the org gets? Only meaningful when hasOwnValue. */
  orgValueInEffect(partnerSettings: unknown, raw: unknown): boolean;
  /** Raw partner value the overrides comparison uses. */
  partnerValue(partnerSettings: unknown): unknown;
  /** Qualifier 'cap' only: the org's own value is above the partner ceiling. */
  clamped?(partnerSettings: unknown, raw: unknown): boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `in`-presence walk through plain objects, matching the resolvers' `field in obj` tests. */
export function presentAt(root: unknown, path: readonly string[]): { present: boolean; value: unknown } {
  let node: unknown = root;
  for (const segment of path) {
    if (!isRecord(node) || !(segment in node)) return { present: false, value: undefined };
    node = node[segment];
  }
  return { present: true, value: node };
}

function at(root: unknown, path: readonly string[]): unknown {
  return presentAt(root, path).value;
}

/**
 * Exactly the characters `String.prototype.trim` removes (ECMAScript
 * WhiteSpace + LineTerminator), so SQL "blank" matches the resolvers' `trim()`.
 */
const JS_TRIM_CHARS =
  ' \t\n\v\f\r                 　﻿';

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** JavaScript truthiness of a jsonb value (SQL NULL and JSON null are falsy). */
function jsTruthySql(value: SQL): SQL {
  return sql`(CASE jsonb_typeof(${value})
    WHEN 'boolean' THEN ${value} = 'true'::jsonb
    WHEN 'number' THEN ${value} <> '0'::jsonb
    WHEN 'string' THEN ${value} <> '""'::jsonb
    WHEN 'object' THEN true
    WHEN 'array' THEN true
    ELSE false END)`;
}

function nonBlankSql(value: SQL): SQL {
  return sql`(CASE WHEN jsonb_typeof(${value}) = 'string' THEN btrim(${value} #>> '{}', ${JS_TRIM_CHARS}) <> '' ELSE false END)`;
}

function presentSql(value: SQL): SQL {
  return sql`(${value} IS NOT NULL)`;
}

function distinctFromSql(value: SQL, partnerValue: unknown): SQL {
  return sql`(${value} IS DISTINCT FROM ${JSON.stringify(partnerValue ?? null)}::jsonb)`;
}

function and(...parts: SQL[]): SQL {
  return sql`(${sql.join(parts, sql` AND `)})`;
}

const settingsAt = (path: readonly string[]): SQL =>
  sql`(${organizations.settings} #> ${sql.param([...path])}::text[])`;

const channelConfigAt = (key: PushoverConfigKey): SQL =>
  sql`(${notificationChannelConfigs.config} -> ${key}::text)`;

// Projections: the only shapes an org value may leave the server in.
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const SAFE_ENUM = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_VERSION = /^[0-9A-Za-z.+_-]{1,64}$/;

function projector(entry: CatalogEntry): (raw: unknown) => unknown {
  if (entry.secret) return () => undefined;
  switch (entry.projection.kind) {
    case 'boolean':
      return (raw) => (typeof raw === 'boolean' ? raw : undefined);
    case 'number':
      return (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined);
    case 'enum':
      return (raw) => (typeof raw === 'string' && SAFE_ENUM.test(raw) ? raw : undefined);
    case 'color':
      return (raw) => (typeof raw === 'string' && HEX_COLOR.test(raw.trim()) ? raw.trim() : undefined);
    case 'version':
      return (raw) => (typeof raw === 'string' && SAFE_VERSION.test(raw.trim()) ? raw.trim() : undefined);
    case 'presence':
    default:
      return () => undefined;
  }
}

/**
 * Two distinct valid values put in the org's slot: when the resolver's output
 * differs between them, the org slot is what the org gets. The resolver
 * decides; nothing here restates its precedence.
 */
function differentialProbe(
  values: readonly [unknown, unknown],
  resolve: (partnerSettings: unknown, orgValue: unknown) => unknown,
): (partnerSettings: unknown) => boolean {
  return (partnerSettings) =>
    !isDeepStrictEqual(resolve(partnerSettings, values[0]), resolve(partnerSettings, values[1]));
}

interface BuildSpec {
  orgSource: NonNullable<OrgSource>;
  valueSql: SQL;
  ownSql: SQL;
  hasOwnValue(raw: unknown): boolean;
  partnerSet(partnerSettings: unknown): boolean;
  inForce?(partnerSettings: unknown): boolean;
  orgValueInEffect(partnerSettings: unknown, raw: unknown): boolean;
  partnerValue(partnerSettings: unknown): unknown;
  /** Qualifier 'cap': the ceiling in force for this partner. */
  cap?(partnerSettings: unknown): number;
}

function build(entry: CatalogEntry, spec: BuildSpec): FieldBinding {
  const inForce = spec.inForce ?? spec.partnerSet;
  const capOf = spec.cap;
  const binding: FieldBinding = {
    id: entry.id,
    orgSource: spec.orgSource,
    project: projector(entry),
    hasOwnValue: spec.hasOwnValue,
    valueSql: spec.valueSql,
    partnerSet: spec.partnerSet,
    inForce,
    orgValueInEffect: spec.orgValueInEffect,
    partnerValue: spec.partnerValue,
    bucketSql(bucket, partnerSettings) {
      switch (bucket) {
        case 'ownValue':
          return spec.ownSql;
        case 'overrides':
          // Equality is not computable on sealed values (random IVs).
          if (entry.secret) return null;
          // Only an org value the resolver lets win can override: not a bucket of a lock.
          if (entry.kind !== 'overridable') return null;
          if (!spec.partnerSet(partnerSettings)) return sql`false`;
          return and(spec.ownSql, distinctFromSql(spec.valueSql, spec.partnerValue(partnerSettings)));
        case 'shadowed':
          // Only a partner value that wins over the org's can shadow it: not a bucket of an override.
          if (entry.kind !== 'locks') return null;
          return inForce(partnerSettings) ? spec.ownSql : sql`false`;
        case 'clamped':
          if (entry.qualifier !== 'cap' || !capOf) return null;
          return and(
            spec.ownSql,
            sql`(CASE WHEN jsonb_typeof(${spec.valueSql}) = 'number' THEN (${spec.valueSql})::numeric > ${capOf(partnerSettings)} ELSE false END)`,
          );
        default:
          return null;
      }
    },
  };
  if (capOf) {
    binding.clamped = (partnerSettings, raw) =>
      typeof raw === 'number' && raw > capOf(partnerSettings);
  }
  return binding;
}

/** No org source (partner-only and unclassified entries): no counts, no drill-down. */
function noOrgSource(entry: CatalogEntry): FieldBinding {
  const partnerSet = (partnerSettings: unknown) =>
    entry.paths.some((path) => presentAt(partnerSettings, path.split('.')).present);
  return {
    id: entry.id,
    orgSource: null,
    project: projector(entry),
    hasOwnValue: () => false,
    bucketSql: () => null,
    valueSql: null,
    partnerSet,
    inForce: partnerSet,
    orgValueInEffect: () => false,
    partnerValue: (partnerSettings) => at(partnerSettings, entry.paths[0]!.split('.')),
  };
}

// ---------------------------------------------------------------------------
// Bindings per resolver family
// ---------------------------------------------------------------------------

/** security.* — partner key present wins (getEffectiveOrgSettings / mfaPolicy). */
function securityBinding(entry: CatalogEntry, field: 'requireMfa' | 'sessionTimeout'): FieldBinding {
  const path = ['security', field] as const;
  const resolve = (partnerSettings: unknown, orgValue: unknown) =>
    resolveEffectiveCategorySettings(partnerSettings, { security: { [field]: orgValue } }).effective.security?.[field];
  const probe = differentialProbe(['probe-a', 'probe-b'], resolve);
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql: settingsAt(path),
    ownSql: presentSql(settingsAt(path)),
    hasOwnValue: (raw) => raw !== undefined,
    partnerSet: (partnerSettings) =>
      resolveEffectiveCategorySettings(partnerSettings, {}).locked.includes(`security.${field}`),
    orgValueInEffect: (partnerSettings) => probe(partnerSettings),
    partnerValue: (partnerSettings) => at(partnerSettings, path),
  });
}

/** defaults.agentUpdatePolicy / maintenanceWindow — partner-locks per field (getOrgAgentUpdateConfig). */
function agentUpdateBinding(entry: CatalogEntry, field: 'agentUpdatePolicy' | 'maintenanceWindow'): FieldBinding {
  const path = ['defaults', field] as const;
  const probes: readonly [string, string] = field === 'agentUpdatePolicy'
    ? ['auto', 'manual']
    : ['Mon 01:00-02:00', 'Tue 01:00-02:00'];
  const resolve = (partnerSettings: unknown, orgValue: unknown) =>
    resolveAgentUpdateConfig(at(partnerSettings, ['defaults']), { [field]: orgValue }).settings;
  const probe = differentialProbe(probes, resolve);
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql: settingsAt(path),
    ownSql: presentSql(settingsAt(path)),
    hasOwnValue: (raw) => raw !== undefined,
    partnerSet: (partnerSettings) => presentAt(partnerSettings, path).present,
    orgValueInEffect: (partnerSettings) => probe(partnerSettings),
    partnerValue: (partnerSettings) => at(partnerSettings, path),
  });
}

/** defaults.agentVersionPins.<component> — inherit-with-override (resolveInheritedAgentVersionPins). */
function versionPinBinding(entry: CatalogEntry, component: 'agent' | 'watchdog'): FieldBinding {
  const path = ['defaults', 'agentVersionPins', component] as const;
  const resolve = (partnerSettings: unknown, orgValue: unknown) =>
    resolveInheritedAgentVersionPins({ agentVersionPins: { [component]: orgValue } }, at(partnerSettings, ['defaults']))[component];
  const probe = differentialProbe(['0.0.1', '0.0.2'], resolve);
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql: settingsAt(path),
    ownSql: presentSql(settingsAt(path)),
    hasOwnValue: (raw) => raw !== undefined,
    partnerSet: (partnerSettings) => presentAt(partnerSettings, path).present,
    orgValueInEffect: (partnerSettings) => probe(partnerSettings),
    partnerValue: (partnerSettings) => at(partnerSettings, path),
  });
}

function partnerDefaults(partnerSettings: unknown): JsonRecord {
  const defaults = at(partnerSettings, ['defaults']);
  return isRecord(defaults) ? defaults : {};
}

/** defaults.defaultEnrollment* — inherit-with-override, TTL clamped to the partner cap (resolveEnrollmentDefaults). */
function enrollmentBinding(
  entry: CatalogEntry,
  field: 'defaultEnrollmentTtlMinutes' | 'defaultEnrollmentDeviceCount',
): FieldBinding {
  const path = ['defaults', field] as const;
  const output = field === 'defaultEnrollmentTtlMinutes' ? 'ttlMinutes' : 'deviceCount';
  const resolve = (partnerSettings: unknown, orgValue: unknown) => {
    const pd = { ...partnerDefaults(partnerSettings) };
    // The ceiling is evaluated separately (the 'clamped' bucket); here only
    // which slot the resolver selects is probed.
    delete pd.maxEnrollmentLinkTtlMinutes;
    return resolveEnrollmentDefaults(pd, { [field]: orgValue })[output];
  };
  const probe = differentialProbe([1, 2], resolve);
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql: settingsAt(path),
    ownSql: presentSql(settingsAt(path)),
    hasOwnValue: (raw) => raw !== undefined,
    partnerSet: (partnerSettings) => presentAt(partnerSettings, path).present,
    orgValueInEffect: (partnerSettings) => probe(partnerSettings),
    partnerValue: (partnerSettings) => at(partnerSettings, path),
    cap: field === 'defaultEnrollmentTtlMinutes'
      ? (partnerSettings) => resolveEnrollmentDefaults(partnerDefaults(partnerSettings), {}).maxTtlMinutes
      : undefined,
  });
}

/** aiApprovals.interactiveTimeoutMinutes — org wins when valid (resolveAiApprovalTimeout). */
function aiApprovalBinding(entry: CatalogEntry): FieldBinding {
  const path = ['aiApprovals', 'interactiveTimeoutMinutes'] as const;
  const value = settingsAt(path);
  const orgSettingsWith = (raw: unknown) => ({ aiApprovals: { interactiveTimeoutMinutes: raw } });
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql: value,
    // An invalid stored value is ignored by the resolver, so it is not an own value.
    ownSql: sql`(CASE WHEN jsonb_typeof(${value}) = 'number'
      THEN ((${value})::numeric BETWEEN ${AI_APPROVAL_TIMEOUT_MIN_MINUTES} AND ${AI_APPROVAL_TIMEOUT_MAX_MINUTES}
        AND (${value})::numeric = trunc((${value})::numeric))
      ELSE false END)`,
    hasOwnValue: (raw) => resolveAiApprovalTimeout(undefined, orgSettingsWith(raw)).source === 'org',
    partnerSet: (partnerSettings) => resolveAiApprovalTimeout(partnerSettings, undefined).source === 'partner',
    orgValueInEffect: (partnerSettings, raw) =>
      resolveAiApprovalTimeout(partnerSettings, orgSettingsWith(raw)).source === 'org',
    partnerValue: (partnerSettings) => at(partnerSettings, path),
  });
}

/** aiBudgets.<field> — partner property present wins (getEffectiveAiBudget). */
function aiBudgetBinding(entry: CatalogEntry, column: AiBudgetColumn): FieldBinding {
  const value = sql`${aiBudgets[column]}`;
  const resolve = (partnerSettings: unknown, orgValue: unknown) =>
    resolveEffectiveAiBudgetFromRows(at(partnerSettings, ['aiBudgets']), { [column]: orgValue })[column];
  const probe = differentialProbe(['probe-a', 'probe-b'], resolve);
  return build(entry, {
    orgSource: { kind: 'aiBudgets', column },
    valueSql: value,
    ownSql: sql`(${value} IS NOT NULL)`,
    hasOwnValue: (raw) => raw !== null && raw !== undefined,
    partnerSet: (partnerSettings) => {
      const found = presentAt(partnerSettings, ['aiBudgets', column]);
      return found.present && found.value !== undefined;
    },
    orgValueInEffect: (partnerSettings) => probe(partnerSettings),
    partnerValue: (partnerSettings) => at(partnerSettings, ['aiBudgets', column]),
  });
}

/** eventLogs — one destination, partner wins only when enabled with a URL (resolveForwardingDestination). */
function eventLogsBinding(entry: CatalogEntry): FieldBinding {
  const path = ['logForwarding'] as const;
  const destination = settingsAt(path);
  // Only the two fields the resolver decides on are selected; the sealed
  // credentials stay in the database.
  const valueSql = sql`(CASE WHEN ${destination} IS NULL THEN NULL ELSE jsonb_build_object(
    'enabled', ${destination} -> 'enabled',
    'elasticsearchUrl', ${destination} -> 'elasticsearchUrl') END)`;
  const partnerEventLogs = (partnerSettings: unknown) => at(partnerSettings, ['eventLogs']);
  return build(entry, {
    orgSource: { kind: 'orgSettings', path },
    valueSql,
    ownSql: and(jsTruthySql(sql`(${destination} -> 'enabled')`), jsTruthySql(sql`(${destination} -> 'elasticsearchUrl')`)),
    hasOwnValue: (raw) => resolveForwardingDestination(undefined, raw).source === 'org',
    partnerSet: (partnerSettings) => {
      const eventLogs = partnerEventLogs(partnerSettings);
      return isRecord(eventLogs) && Object.keys(eventLogs).length > 0;
    },
    inForce: (partnerSettings) => resolveForwardingDestination(partnerEventLogs(partnerSettings), undefined).source === 'partner',
    orgValueInEffect: (partnerSettings, raw) =>
      resolveForwardingDestination(partnerEventLogs(partnerSettings), raw).source === 'org',
    partnerValue: (partnerSettings) => partnerEventLogs(partnerSettings),
  });
}

const PUSHOVER_DEFAULT_KEY: Record<PushoverConfigKey, { setting: string; defaults: keyof PartnerPushoverDefaults }> = {
  token: { setting: 'pushoverAppToken', defaults: 'appToken' },
  user: { setting: 'pushoverDefaultUser', defaults: 'defaultUser' },
  sound: { setting: 'pushoverDefaultSound', defaults: 'defaultSound' },
  priority: { setting: 'pushoverDefaultPriority', defaults: 'defaultPriority' },
};

/** Stands in for a set partner default; never compared with real data. */
const PARTNER_PROBE = 'partner-default-probe';

/** notifications.pushover* — fill-blank per org Pushover channel (applyPartnerPushoverDefaults). */
function pushoverBinding(entry: CatalogEntry, key: PushoverConfigKey): FieldBinding {
  const value = channelConfigAt(key);
  const settingPath = ['notifications', PUSHOVER_DEFAULT_KEY[key].setting] as const;
  const defaultsKey = PUSHOVER_DEFAULT_KEY[key].defaults;
  // A channel value survives the merge with a set partner default ⇔ the
  // resolver treats it as the channel's own value.
  const survives = (raw: unknown, defaults: PartnerPushoverDefaults): boolean => {
    const config = (raw === undefined ? {} : { [key]: raw }) as PushoverConfig;
    return applyPartnerPushoverDefaults(config, defaults)[key] !== PARTNER_PROBE;
  };
  const credential = key === 'token' || key === 'user';
  return build(entry, {
    orgSource: { kind: 'pushoverChannels', key },
    valueSql: value,
    // Credentials are inherited when blank; sound and priority only when undefined.
    ownSql: credential ? nonBlankSql(value) : presentSql(value),
    hasOwnValue: (raw) => survives(raw, { [defaultsKey]: PARTNER_PROBE } as PartnerPushoverDefaults),
    // Mirrors readPartnerPushoverDefaults' set tests without opening the sealed values.
    partnerSet: (partnerSettings) => {
      const stored = at(partnerSettings, settingPath);
      return key === 'priority' ? typeof stored === 'number' : nonBlank(stored);
    },
    orgValueInEffect: (partnerSettings, raw) => {
      const stored = at(partnerSettings, settingPath);
      const set = key === 'priority' ? typeof stored === 'number' : nonBlank(stored);
      return survives(raw, (set ? { [defaultsKey]: PARTNER_PROBE } : {}) as PartnerPushoverDefaults);
    },
    partnerValue: (partnerSettings) => at(partnerSettings, settingPath),
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const AI_BUDGET_COLUMNS: readonly AiBudgetColumn[] = [
  'enabled',
  'monthlyBudgetCents',
  'dailyBudgetCents',
  'maxTurnsPerSession',
  'messagesPerMinutePerUser',
  'messagesPerHourPerOrg',
  'approvalMode',
  'alertThresholdPercents',
  'toolRateLimitMultiplier',
];

function bindingFor(entry: CatalogEntry): FieldBinding {
  if (entry.kind === 'partnerOnly' || entry.kind === 'unclassified') return noOrgSource(entry);
  switch (entry.id) {
    case 'security.requireMfa':
      return securityBinding(entry, 'requireMfa');
    case 'security.sessionTimeout':
      return securityBinding(entry, 'sessionTimeout');
    case 'defaults.agentUpdatePolicy':
      return agentUpdateBinding(entry, 'agentUpdatePolicy');
    case 'defaults.maintenanceWindow':
      return agentUpdateBinding(entry, 'maintenanceWindow');
    case 'defaults.agentVersionPins.agent':
      return versionPinBinding(entry, 'agent');
    case 'defaults.agentVersionPins.watchdog':
      return versionPinBinding(entry, 'watchdog');
    case 'defaults.defaultEnrollmentTtlMinutes':
      return enrollmentBinding(entry, 'defaultEnrollmentTtlMinutes');
    case 'defaults.defaultEnrollmentDeviceCount':
      return enrollmentBinding(entry, 'defaultEnrollmentDeviceCount');
    case 'aiApprovals.interactiveTimeoutMinutes':
      return aiApprovalBinding(entry);
    case 'eventLogs':
      return eventLogsBinding(entry);
    case 'notifications.pushoverAppToken':
      return pushoverBinding(entry, 'token');
    case 'notifications.pushoverDefaultUser':
      return pushoverBinding(entry, 'user');
    case 'notifications.pushoverDefaultSound':
      return pushoverBinding(entry, 'sound');
    case 'notifications.pushoverDefaultPriority':
      return pushoverBinding(entry, 'priority');
    default: {
      const budgetField = entry.id.startsWith('aiBudgets.') ? entry.id.slice('aiBudgets.'.length) : null;
      if (budgetField && (AI_BUDGET_COLUMNS as readonly string[]).includes(budgetField)) {
        return aiBudgetBinding(entry, budgetField as AiBudgetColumn);
      }
      // A classified entry with no binding is a programming error, caught at load.
      throw new Error(`partner settings catalog entry has no binding: ${entry.id}`);
    }
  }
}

function checkedBindingFor(entry: CatalogEntry): FieldBinding {
  const binding = bindingFor(entry);
  // A cap field without a clamp test would silently report every org unclamped.
  if (entry.qualifier === 'cap' && binding.orgSource && !binding.clamped) {
    throw new Error(`partner settings cap field has no clamp test: ${entry.id}`);
  }
  return binding;
}

export const BINDINGS: Readonly<Record<string, FieldBinding>> = Object.freeze(
  Object.fromEntries(PARTNER_SETTINGS_CATALOG.map((entry) => [entry.id, checkedBindingFor(entry)])),
);

/** The table a table-column org source joins (one row per org). */
export const ORG_SOURCE_TABLES = { aiBudgets, portalBranding } as const;
