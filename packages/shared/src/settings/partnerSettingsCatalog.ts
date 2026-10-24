/**
 * Partner settings field catalog (#9170, spec 2026-10-18 §5.2).
 *
 * One declarative entry per partner setting (or per group of paths that
 * resolve together) on the partner settings page. It states what the setting
 * can do to the organizations under the partner — its `kind` — and carries the
 * read-model DTO types the inheritance routes return. The web badges and the
 * API's `GET /orgs/partners/me/settings-inheritance` use the same ids.
 *
 * The catalog describes the runtime resolvers; it never changes them. The API
 * half (where each field's org value is stored, the count predicates, secret
 * handling) lives in `apps/api/src/services/partnerSettingsInheritance/` and
 * must never be imported here: this module is reachable from the browser-safe
 * root barrel.
 *
 * Ids are stable. Renaming an id is a reviewed change (see the inline snapshot
 * in the test).
 */
import { AI_BUDGET_DEFAULTS, type AiBudgetDefaults } from '../constants/aiBudgetDefaults';
import { AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES } from '../validators/aiApprovalSettings';
import {
  MAX_ENROLLMENT_TTL_MINUTES,
  PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT,
  PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES,
} from '../validators/enrollmentDefaults';

export const CATALOG_TAB_KEYS = [
  'regional',
  'defaults',
  'eventLogs',
  'remoteAccess',
  'security',
  'notifications',
  'aiBudgets',
  'aiApprovals',
  'branding',
] as const;

export type CatalogTabKey = (typeof CATALOG_TAB_KEYS)[number];

/**
 * - `locks`: the partner value wins over the org's.
 * - `overridable`: the org value wins; the partner value is the default
 *   (including fill-blank defaults).
 * - `partnerOnly`: orgs have no value of their own; the setting is partner-wide.
 * - `unclassified`: no badge and no counts until a maintainer classifies it.
 */
export type FieldKind = 'locks' | 'overridable' | 'partnerOnly' | 'unclassified';

/**
 * - `cap`: an org may override, but only up to a partner ceiling (`capFieldId`).
 * - `conditional`: the lock is in force only in a stated state.
 */
export type FieldQualifier = 'cap' | 'conditional';

/**
 * The only shape in which an org's own value may leave the server. Anything
 * not representable by one of these, and every secret, is presence-only
 * ("set" / "not set").
 */
export type ValueProjection =
  | { kind: 'presence' }
  | { kind: 'number'; unit?: 'minutes' | 'days' | 'cents' | 'percent' }
  | { kind: 'boolean' }
  | { kind: 'enum' }
  | { kind: 'color' }
  | { kind: 'version' };

export interface CatalogConsumer {
  /** Stable consumer id, e.g. 'reports'. */
  id: string;
  /** i18n key for the consumer's label. */
  labelKey: string;
}

export interface CatalogEntry {
  /** Stable, e.g. 'defaults.defaultEnrollmentTtlMinutes'. Never renamed once shipped. */
  id: string;
  tab: CatalogTabKey;
  /** Dot paths in `partners.settings` covered by this entry. */
  paths: readonly string[];
  kind: FieldKind;
  qualifier?: FieldQualifier;
  /** With qualifier 'cap': the catalog id of the ceiling field. */
  capFieldId?: string;
  /** Runtime readers that honour the value, where they disagree. */
  consumers?: readonly CatalogConsumer[];
  /** What applies when neither level sets the value. Imported from its owner, never copied. */
  platformDefault?: unknown;
  /** True when any covered path is sealed at rest. */
  secret: boolean;
  /** 'presence' whenever `secret`. */
  projection: ValueProjection;
  /** `OrgSettingsPage` hash for the drill-down link (`/settings/organizations/<id>#<hash>`). */
  orgSettingsHash: string | null;
}

// ---------------------------------------------------------------------------
// Read-model DTOs (returned by the inheritance routes)
// ---------------------------------------------------------------------------

/**
 * Fixed meanings of the count words (spec §5.4). The UI copy uses these
 * definitions; the API computes exactly these sets.
 */
export const COUNT_TERMS = Object.freeze({
  ownValue: 'Has its own value: the org has stored a value at its own source that the runtime resolver treats as set.',
  overrides: 'Overrides: the org has its own value, it differs from the partner value, and the resolver lets the org value win.',
  shadowed: 'Shadowed: the org has its own value, but the partner value wins, so the org value is not in effect.',
  inEffect: 'In effect: the value the runtime resolver uses for that org right now.',
});

export interface InheritanceCounts {
  ownValue: number;
  /** null when the field is secret: sealed values cannot be compared for equality. */
  overrides: number | null;
  shadowed: number;
  /** Only for qualifier 'cap': orgs whose own value is above the partner ceiling. */
  clamped?: number;
}

export interface InheritanceFieldDto {
  id: string;
  kind: FieldKind;
  qualifier?: FieldQualifier;
  /** The partner has stored a value the resolver treats as set. */
  partnerSet: boolean;
  /** The partner value is in force now (differs from partnerSet only for 'conditional'). */
  inForce: boolean;
  platformDefault: unknown;
  /** True when the field is sealed at rest: values are presence-only and `counts.overrides` is null. (Not named `secret`: `isSecretJsonPath` treats that key name as a sealed value.) */
  sealed: boolean;
  /** `null` when the field has no org-level value to count (partner-only or unclassified), never zeros. */
  counts: InheritanceCounts | null;
  byConsumer?: { consumerId: string; counts: InheritanceCounts }[];
}

export interface InheritanceTabDto {
  tab: CatalogTabKey;
  /** Orgs the caller can see (same population as the org list). */
  orgCount: number;
  fields: InheritanceFieldDto[];
}

/** Projected own value: `value` only for non-secret fields with a value projection. */
export interface InheritanceOwnValueDto {
  set: boolean;
  value?: unknown;
}

export interface InheritanceOrgRowDto {
  orgId: string;
  orgName: string;
  ownValue: InheritanceOwnValueDto;
  /** The org's own value is what the runtime resolver uses for it. */
  inEffect: boolean;
  /** Per-channel detail for channel-sourced fields (an org can have several). */
  channels?: { channelId: string; name: string; ownValue: InheritanceOwnValueDto }[];
}

export interface InheritanceOrgPageDto {
  field: string;
  rows: InheritanceOrgRowDto[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

const PRESENCE: ValueProjection = { kind: 'presence' };
const BOOLEAN: ValueProjection = { kind: 'boolean' };
const ENUM: ValueProjection = { kind: 'enum' };
const NUMBER: ValueProjection = { kind: 'number' };
const MINUTES: ValueProjection = { kind: 'number', unit: 'minutes' };
const CENTS: ValueProjection = { kind: 'number', unit: 'cents' };
const VERSION: ValueProjection = { kind: 'version' };

/** Not yet classified: no badge, no counts, presence-only, no link. */
function unclassified(
  tab: CatalogTabKey,
  id: string,
  paths: readonly string[],
  secret = false,
): CatalogEntry {
  return { id, tab, paths, kind: 'unclassified', secret, projection: PRESENCE, orgSettingsHash: null };
}

function aiBudget(field: keyof AiBudgetDefaults, projection: ValueProjection): CatalogEntry {
  return {
    id: `aiBudgets.${field}`,
    tab: 'aiBudgets',
    paths: [`aiBudgets.${field}`],
    kind: 'locks',
    platformDefault: AI_BUDGET_DEFAULTS[field],
    secret: false,
    projection,
    orgSettingsHash: 'ai',
  };
}

const ENTRIES: CatalogEntry[] = [
  // Regional — on PartnerSettings itself.
  unclassified('regional', 'regional.timezone', ['timezone']),
  { id: 'regional.dateFormat', tab: 'regional', paths: ['dateFormat'], kind: 'partnerOnly', secret: false, projection: ENUM, orgSettingsHash: null },
  { id: 'regional.timeFormat', tab: 'regional', paths: ['timeFormat'], kind: 'partnerOnly', secret: false, projection: ENUM, orgSettingsHash: null },
  unclassified('regional', 'regional.language', ['language']),
  { id: 'regional.businessHours', tab: 'regional', paths: ['businessHours.preset', 'businessHours.custom'], kind: 'partnerOnly', secret: false, projection: PRESENCE, orgSettingsHash: null },

  // Security
  unclassified('security', 'security.minLength', ['security.minLength']),
  unclassified('security', 'security.complexity', ['security.complexity']),
  unclassified('security', 'security.expirationDays', ['security.expirationDays']),
  { id: 'security.requireMfa', tab: 'security', paths: ['security.requireMfa'], kind: 'locks', platformDefault: false, secret: false, projection: BOOLEAN, orgSettingsHash: 'security' },
  unclassified('security', 'security.allowedMethods', ['security.allowedMethods.totp', 'security.allowedMethods.sms']),
  { id: 'security.sessionTimeout', tab: 'security', paths: ['security.sessionTimeout'], kind: 'locks', secret: false, projection: MINUTES, orgSettingsHash: 'security' },
  unclassified('security', 'security.maxSessions', ['security.maxSessions']),
  unclassified('security', 'security.ipAllowlist', ['security.ipAllowlist']),

  // Notifications
  unclassified('notifications', 'notifications.fromAddress', ['notifications.fromAddress']),
  unclassified('notifications', 'notifications.replyTo', ['notifications.replyTo']),
  unclassified('notifications', 'notifications.useCustomSmtp', ['notifications.useCustomSmtp']),
  unclassified('notifications', 'notifications.smtpHost', ['notifications.smtpHost']),
  unclassified('notifications', 'notifications.smtpPort', ['notifications.smtpPort']),
  unclassified('notifications', 'notifications.smtpUsername', ['notifications.smtpUsername']),
  unclassified('notifications', 'notifications.smtpEncryption', ['notifications.smtpEncryption']),
  unclassified('notifications', 'notifications.slackWebhookUrl', ['notifications.slackWebhookUrl'], true),
  unclassified('notifications', 'notifications.slackChannel', ['notifications.slackChannel']),
  unclassified('notifications', 'notifications.webhooks', ['notifications.webhooks'], true),
  // Open-ended dictionary: one entry for the whole sub-object.
  unclassified('notifications', 'notifications.preferences', ['notifications.preferences']),
  // Pushover: fill-blank defaults for each org Pushover channel.
  { id: 'notifications.pushoverAppToken', tab: 'notifications', paths: ['notifications.pushoverAppToken'], kind: 'overridable', secret: true, projection: PRESENCE, orgSettingsHash: null },
  { id: 'notifications.pushoverDefaultUser', tab: 'notifications', paths: ['notifications.pushoverDefaultUser'], kind: 'overridable', secret: true, projection: PRESENCE, orgSettingsHash: null },
  { id: 'notifications.pushoverDefaultSound', tab: 'notifications', paths: ['notifications.pushoverDefaultSound'], kind: 'overridable', secret: false, projection: ENUM, orgSettingsHash: null },
  { id: 'notifications.pushoverDefaultPriority', tab: 'notifications', paths: ['notifications.pushoverDefaultPriority'], kind: 'overridable', secret: false, projection: NUMBER, orgSettingsHash: null },
  unclassified('notifications', 'notifications.pushoverTicketAssignmentFallback', ['notifications.pushoverTicketAssignmentFallback']),

  // Event logs: one destination, resolved all-or-nothing.
  {
    id: 'eventLogs',
    tab: 'eventLogs',
    paths: [
      'eventLogs.enabled',
      'eventLogs.elasticsearchUrl',
      'eventLogs.elasticsearchApiKey',
      'eventLogs.elasticsearchUsername',
      'eventLogs.elasticsearchPassword',
      'eventLogs.indexPrefix',
    ],
    kind: 'locks',
    qualifier: 'conditional',
    secret: true,
    projection: PRESENCE,
    orgSettingsHash: 'event-logs',
  },

  // Defaults
  // Open-ended dictionary: one entry for the whole sub-object.
  unclassified('defaults', 'defaults.policyDefaults', ['defaults.policyDefaults']),
  // `defaults.deviceGroup` is org-level only (#9617): a partner value cannot name a
  // per-org group and the resolver ignores one, so it is not a partner setting.
  unclassified('defaults', 'defaults.autoEnrollment', [
    'defaults.autoEnrollment.enabled',
    'defaults.autoEnrollment.requireApproval',
  ]),
  { id: 'defaults.agentUpdatePolicy', tab: 'defaults', paths: ['defaults.agentUpdatePolicy'], kind: 'locks', platformDefault: 'staged', secret: false, projection: ENUM, orgSettingsHash: 'general' },
  { id: 'defaults.maintenanceWindow', tab: 'defaults', paths: ['defaults.maintenanceWindow'], kind: 'locks', platformDefault: null, secret: false, projection: PRESENCE, orgSettingsHash: 'general' },
  // Agent and watchdog pins are independent knobs, resolved per component.
  { id: 'defaults.agentVersionPins.agent', tab: 'defaults', paths: ['defaults.agentVersionPins.agent'], kind: 'overridable', platformDefault: null, secret: false, projection: VERSION, orgSettingsHash: 'general' },
  { id: 'defaults.agentVersionPins.watchdog', tab: 'defaults', paths: ['defaults.agentVersionPins.watchdog'], kind: 'overridable', platformDefault: null, secret: false, projection: VERSION, orgSettingsHash: 'general' },
  {
    id: 'defaults.defaultEnrollmentTtlMinutes',
    tab: 'defaults',
    paths: ['defaults.defaultEnrollmentTtlMinutes'],
    kind: 'overridable',
    qualifier: 'cap',
    capFieldId: 'defaults.maxEnrollmentLinkTtlMinutes',
    platformDefault: PRODUCT_DEFAULT_ENROLLMENT_TTL_MINUTES,
    secret: false,
    projection: MINUTES,
    orgSettingsHash: 'general',
  },
  { id: 'defaults.defaultEnrollmentDeviceCount', tab: 'defaults', paths: ['defaults.defaultEnrollmentDeviceCount'], kind: 'overridable', platformDefault: PRODUCT_DEFAULT_ENROLLMENT_DEVICE_COUNT, secret: false, projection: NUMBER, orgSettingsHash: 'general' },
  { id: 'defaults.maxEnrollmentLinkTtlMinutes', tab: 'defaults', paths: ['defaults.maxEnrollmentLinkTtlMinutes'], kind: 'partnerOnly', platformDefault: MAX_ENROLLMENT_TTL_MINUTES, secret: false, projection: MINUTES, orgSettingsHash: null },

  // Branding
  unclassified('branding', 'branding.logoUrl', ['branding.logoUrl']),
  unclassified('branding', 'branding.primaryColor', ['branding.primaryColor']),
  unclassified('branding', 'branding.secondaryColor', ['branding.secondaryColor']),
  unclassified('branding', 'branding.theme', ['branding.theme']),
  unclassified('branding', 'branding.customCss', ['branding.customCss']),

  // AI budgets: every field locks.
  aiBudget('enabled', BOOLEAN),
  aiBudget('monthlyBudgetCents', CENTS),
  aiBudget('dailyBudgetCents', CENTS),
  aiBudget('maxTurnsPerSession', NUMBER),
  aiBudget('messagesPerMinutePerUser', NUMBER),
  aiBudget('messagesPerHourPerOrg', NUMBER),
  aiBudget('approvalMode', ENUM),
  aiBudget('alertThresholdPercents', PRESENCE),
  aiBudget('toolRateLimitMultiplier', NUMBER),

  // AI approvals
  {
    id: 'aiApprovals.interactiveTimeoutMinutes',
    tab: 'aiApprovals',
    paths: ['aiApprovals.interactiveTimeoutMinutes'],
    kind: 'overridable',
    platformDefault: AI_APPROVAL_TIMEOUT_DEFAULT_MINUTES,
    secret: false,
    projection: MINUTES,
    orgSettingsHash: 'ai',
  },

  // Remote access
  // Each provider may carry a sealed launcher password.
  { id: 'remoteAccessProviders.providers', tab: 'remoteAccess', paths: ['remoteAccessProviders.providers'], kind: 'partnerOnly', secret: true, projection: PRESENCE, orgSettingsHash: null },
  { id: 'remoteAccessProviders.defaultProviderId', tab: 'remoteAccess', paths: ['remoteAccessProviders.defaultProviderId'], kind: 'partnerOnly', secret: false, projection: PRESENCE, orgSettingsHash: null },
  { id: 'networkProxy.dedicatedTunnelOrigin', tab: 'remoteAccess', paths: ['networkProxy.dedicatedTunnelOrigin'], kind: 'partnerOnly', platformDefault: false, secret: false, projection: BOOLEAN, orgSettingsHash: null },
];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export const PARTNER_SETTINGS_CATALOG: readonly CatalogEntry[] = deepFreeze(ENTRIES);

export const CATALOG_BY_ID: Readonly<Record<string, CatalogEntry>> = Object.freeze(
  Object.fromEntries(PARTNER_SETTINGS_CATALOG.map((entry) => [entry.id, entry])),
);

const BY_TAB: Readonly<Record<CatalogTabKey, readonly CatalogEntry[]>> = Object.freeze(
  Object.fromEntries(
    CATALOG_TAB_KEYS.map((tab) => [tab, Object.freeze(PARTNER_SETTINGS_CATALOG.filter((e) => e.tab === tab))]),
  ) as Record<CatalogTabKey, readonly CatalogEntry[]>,
);

export function catalogForTab(tab: CatalogTabKey): readonly CatalogEntry[] {
  return BY_TAB[tab] ?? [];
}

export function isCatalogTabKey(value: unknown): value is CatalogTabKey {
  return typeof value === 'string' && (CATALOG_TAB_KEYS as readonly string[]).includes(value);
}
