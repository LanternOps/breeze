import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace so values can be embedded in
// $filter expressions without escaping ambiguity.
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const searchTermSchema = z.string().min(1).max(120).regex(/^[^"'\\]+$/);
// Graph composite site id: host,siteCollectionGuid-ish,siteGuid-ish (comma-separated tokens).
const siteIdSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9.,_-]+$/);

const pageSize = (max: number) => z.number().int().min(1).max(max).optional();

export const M365_INTERACTIVE_READ_ACTION_IDS = [
  'm365.user.list', 'm365.user.get', 'm365.signins.list',
  'm365.intune.device.list', 'm365.intune.device.get',
  'm365.group.list', 'm365.group.get', 'm365.group.members.list',
  'm365.org.get', 'm365.org.skus.list',
  'm365.sites.list', 'm365.site.get',
] as const;

/** Whole-domain snapshot pulls. Served on /v1/sync-action only (spec §4.2). */
export const M365_SYNC_ACTION_IDS = [
  'm365.sync.users',
  'm365.sync.signin_activity',
  'm365.sync.intune_devices',
  'm365.sync.ca_policies',
  'm365.sync.skus',
  'm365.sync.secure_score',
  // #5784 W05. /auditLogs/signIns over a bounded window — a DIFFERENT Graph
  // surface from the interactive `m365.signins.list`, which keeps its 7-day /
  // 100-row cap and is deliberately left untouched.
  'm365.sync.signin_events',
] as const;

export const M365_READ_ACTION_IDS = [
  ...M365_INTERACTIVE_READ_ACTION_IDS,
  ...M365_SYNC_ACTION_IDS,
] as const;

export type M365InteractiveReadActionId = typeof M365_INTERACTIVE_READ_ACTION_IDS[number];
export type M365SyncActionId = typeof M365_SYNC_ACTION_IDS[number];
export type M365ReadActionId = typeof M365_READ_ACTION_IDS[number];

const SYNC_ACTION_ID_SET: ReadonlySet<string> = new Set(M365_SYNC_ACTION_IDS);

export function isM365SyncActionId(id: string): id is M365SyncActionId {
  return SYNC_ACTION_ID_SET.has(id);
}

/** Max size of the executor-encrypted sign-in continuation blob (spec §4.1). */
export const M365_SYNC_CONTINUATION_MAX_CHARS = 4096;

/** Per-action projection allowlists. The executor projects every returned
 *  object through these; they are the only fields that ever leave it. */
export const M365_READ_ACTION_FIELDS: Record<M365ReadActionId, readonly string[]> = {
  'm365.user.list': ['id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle', 'department', 'createdDateTime'],
  'm365.user.get': ['id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle', 'department', 'createdDateTime', 'assignedLicenses', 'usageLocation', 'onPremisesSyncEnabled'],
  'm365.signins.list': ['id', 'createdDateTime', 'userPrincipalName', 'userId', 'appDisplayName', 'ipAddress', 'clientAppUsed', 'conditionalAccessStatus', 'isInteractive', 'status', 'location', 'deviceDetail'],
  'm365.intune.device.list': ['id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime', 'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime'],
  'm365.intune.device.get': ['id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime', 'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer', 'serialNumber', 'azureADDeviceId', 'jailBroken', 'managementAgent'],
  'm365.group.list': ['id', 'displayName', 'mail', 'groupTypes', 'securityEnabled', 'membershipRule', 'createdDateTime'],
  'm365.group.get': ['id', 'displayName', 'mail', 'groupTypes', 'securityEnabled', 'membershipRule', 'createdDateTime', 'description'],
  'm365.group.members.list': ['id', 'displayName', 'userPrincipalName', 'mail'],
  'm365.org.get': ['id', 'displayName', 'verifiedDomains', 'countryLetterCode', 'createdDateTime'],
  'm365.org.skus.list': ['id', 'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'appliesTo', 'capabilityStatus'],
  'm365.sites.list': ['id', 'name', 'displayName', 'webUrl', 'createdDateTime', 'lastModifiedDateTime'],
  'm365.site.get': ['id', 'name', 'displayName', 'webUrl', 'createdDateTime', 'lastModifiedDateTime'],

  // --- sync actions (spec §4.1). Computed keys (assignedLicenses as sku ids,
  // mfa*, adminRoles, lastSuccessfulSignInAt, controlScores) are allowlisted
  // here explicitly; the executor builds them and projects through this list
  // exactly as it does raw Graph objects.
  //
  // Nested shapes are NOT expressible in this flat list. They are built key by
  // key in syncActions.ts; anything not named here must never be emitted:
  //   m365.sync.users     adminRoles[]:    { roleTemplateId, displayName, viaGroupId? }
  //                                        (null = unknown, never [])
  //   m365.sync.skus      prepaidUnits:    { enabled, suspended, warning }
  //                                        (Graph's lockedOut is DROPPED)
  //   m365.sync.ca_policies  conditions / grantControls / sessionControls pass
  //                                        through as opaque Graph objects
  //   m365.sync.secure_score  controlScores[]: { controlName, title, score,
  //                                        maxScore, implementationStatus }
  //                                        title and maxScore are joined from
  //                                        /security/secureScoreControlProfiles
  //                                        and are `null` when that source fails
  //                                        or the control has no profile;
  //                                        Graph's `description` is DROPPED.
  'm365.sync.users': [
    'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
    'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime',
    'assignedLicenses', 'mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles',
  ],
  'm365.sync.signin_activity': ['id', 'lastSuccessfulSignInAt'],
  'm365.sync.intune_devices': [
    'id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime',
    'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer',
    'serialNumber', 'azureADDeviceId', 'managementAgent', 'jailBroken',
  ],
  'm365.sync.ca_policies': [
    'id', 'displayName', 'state', 'createdDateTime', 'modifiedDateTime',
    'conditions', 'grantControls', 'sessionControls',
  ],
  'm365.sync.skus': [
    'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'capabilityStatus', 'appliesTo',
  ],
  'm365.sync.secure_score': [
    'id', 'createdDateTime', 'currentScore', 'maxScore', 'activeUserCount',
    'licensedUserCount', 'controlScores',
  ],
  // #5784 W05. `location` and `status` pass through as the small Graph objects
  // they are and the PERSISTER flattens them into their own columns
  // (location_city/location_country, status_error_code/status_failure_reason) —
  // nothing jsonb-shaped is ever stored. deviceDetail and
  // appliedConditionalAccessPolicies are deliberately NOT projected: they are
  // the two fat sub-objects on the signIn resource and the report renders
  // neither. riskLevelAggregated/riskState come from the signIn resource under
  // AuditLog.Read.All — Identity Protection's riskyUsers collection is NOT
  // fetched, which is what keeps the consent manifest at v3.
  'm365.sync.signin_events': [
    'id', 'createdDateTime', 'userId', 'userPrincipalName', 'appId', 'appDisplayName',
    'clientAppUsed', 'ipAddress', 'location', 'conditionalAccessStatus', 'status',
    'riskLevelAggregated', 'riskState', 'isInteractive',
  ],
};

const INTERACTIVE_BRANCHES = [
  z.object({
    type: z.literal('m365.user.list'),
    search: searchTermSchema.optional(),
    accountEnabled: z.boolean().optional(),
    department: searchTermSchema.optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.user.get'),
    userIdOrUpn: userIdOrUpnSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.signins.list'),
    userPrincipalName: userIdOrUpnSchema.optional(),
    sinceHours: z.number().int().min(1).max(168).optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.intune.device.list'),
    complianceState: z.enum(['compliant', 'noncompliant', 'inGracePeriod', 'unknown']).optional(),
    operatingSystem: z.enum(['Windows', 'macOS', 'iOS', 'Android', 'Linux']).optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.intune.device.get'),
    deviceId: guidSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.list'),
    search: searchTermSchema.optional(),
    pageSize: pageSize(50),
  }).strict(),
  z.object({
    type: z.literal('m365.group.get'),
    groupId: guidSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.members.list'),
    groupId: guidSchema,
    pageSize: pageSize(100),
  }).strict(),
  z.object({ type: z.literal('m365.org.get') }).strict(),
  z.object({ type: z.literal('m365.org.skus.list') }).strict(),
  z.object({
    type: z.literal('m365.sites.list'),
    search: searchTermSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.site.get'),
    siteId: siteIdSchema,
  }).strict(),
] as const;

const SYNC_BRANCHES = [
  z.object({ type: z.literal('m365.sync.users') }).strict(),
  z.object({
    type: z.literal('m365.sync.signin_activity'),
    // Opaque to the API: AES-256-GCM ciphertext minted by the executor.
    continuation: z.string().min(1).max(M365_SYNC_CONTINUATION_MAX_CHARS).optional(),
  }).strict(),
  z.object({ type: z.literal('m365.sync.intune_devices') }).strict(),
  z.object({ type: z.literal('m365.sync.ca_policies') }).strict(),
  z.object({ type: z.literal('m365.sync.skus') }).strict(),
  z.object({
    type: z.literal('m365.sync.secure_score'),
    // 90 daily scores on a first/re-seed run, 3 otherwise (spec §4.1).
    backfill: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal('m365.sync.signin_events'),
    /**
     * #5784 W05. The half-open event window `createdDateTime >= since` and
     * `< until`, both ISO instants. BOTH are optional so a call that arrives
     * without a window is still bounded rather than a full-tenant scan: the
     * executor defaults `until` to its own fetch time and `since` to
     * `until - SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS`, which is exactly the
     * cold-start window the API asks for on an org's first run.
     */
    since: z.string().datetime().optional(),
    until: z.string().datetime().optional(),
    // Opaque to the API: AES-256-GCM ciphertext minted by the executor.
    continuation: z.string().min(1).max(M365_SYNC_CONTINUATION_MAX_CHARS).optional(),
  }).strict(),
] as const;

/**
 * Cold start for an org with no events yet. Graph retains ~30 days, but a first
 * run pulling a month in one go would blow the per-run item cap; the next runs
 * catch up through the overlapping delta window.
 */
export const SIGNIN_EVENTS_DEFAULT_WINDOW_DAYS = 7;

export const m365SyncActionSchema = z.discriminatedUnion('type', SYNC_BRANCHES);
export type M365SyncAction = z.infer<typeof m365SyncActionSchema>;

export const m365ReadActionSchema = z.discriminatedUnion('type', [
  ...INTERACTIVE_BRANCHES,
  ...SYNC_BRANCHES,
]);

export type M365ReadAction = z.infer<typeof m365ReadActionSchema>;
export type M365InteractiveReadAction = Exclude<M365ReadAction, M365SyncAction>;

export function isM365SyncAction(action: M365ReadAction): action is M365SyncAction {
  return isM365SyncActionId(action.type);
}

export const readActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  action: m365ReadActionSchema,
}).strict();

export type ReadActionRequest = z.infer<typeof readActionRequestSchema>;

export const readActionFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
  'graph_response_too_large',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_invalid',
]);

export type ReadActionFailureCode = z.infer<typeof readActionFailureCodeSchema>;

const readActionItemSchema = z.record(z.string(), z.unknown());

export const readActionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    kind: z.literal('collection'),
    items: z.array(readActionItemSchema),
    truncated: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    kind: z.literal('resource'),
    resource: readActionItemSchema,
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: readActionFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(1).max(300).optional(),
  }).strict(),
]);

export type ReadActionResult = z.infer<typeof readActionResultSchema>;

export const syncActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  action: m365SyncActionSchema,
}).strict();

export type SyncActionRequest = z.infer<typeof syncActionRequestSchema>;

/**
 * Per-sub-source health for one domain pull (spec §4.3, §6). A domain's
 * PRIMARY source failing is a whole-action failure; a secondary source failing
 * is recorded here and the domain persists as `partial`.
 */
export const m365SyncSourceStateSchema = z.enum([
  'ok', 'unlicensed', 'permission_missing', 'throttled', 'error',
]);

export type M365SyncSourceState = z.infer<typeof m365SyncSourceStateSchema>;

export interface M365SyncActionResult {
  success: true;
  kind: 'sync';
  items: Record<string, unknown>[];
  truncated: boolean;
  continuation?: string;
  fetchedAt: string;
  sources: Record<string, M365SyncSourceState>;
}

export const m365SyncActionResultSchema: z.ZodType<M365SyncActionResult> = z.object({
  success: z.literal(true),
  kind: z.literal('sync'),
  items: z.array(readActionItemSchema),
  truncated: z.boolean(),
  continuation: z.string().min(1).max(M365_SYNC_CONTINUATION_MAX_CHARS).optional(),
  fetchedAt: z.string().datetime(),
  sources: z.record(z.string(), m365SyncSourceStateSchema),
}).strict();

/**
 * The read failure codes plus `continuation_invalid`. Deliberately NOT folded
 * into readActionFailureCodeSchema: that enum keys the exhaustive
 * FAILURE_MESSAGES record in the API's readActionService, which this contract
 * has no business widening.
 *
 * The member list is spelled out rather than spread from
 * `readActionFailureCodeSchema.options` because `z.enum` needs a literal tuple
 * and a spread of `.options` degrades to `string[]`. The duplication is held
 * honest two ways: the `_AssertSyncFailureCodeParity` line below fails `tsc` if
 * the schema and the exported type drift apart, and `readActions.test.ts`
 * asserts `m365SyncFailureCodeSchema.options` equals
 * `[...readActionFailureCodeSchema.options, 'continuation_invalid']`, so adding
 * a read code without adding it here is a red test, not a silent gap.
 */
export const m365SyncFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'graph_permission_missing',
  'graph_license_required',
  'graph_not_found',
  'graph_throttled',
  'graph_response_too_large',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_response_invalid',
  'continuation_invalid',
]);

/**
 * Written exactly as the overview's shared interface contract states it. W04
 * imports this name, `m365SyncFailureCodeSchema`, and
 * `m365SyncActionResponseSchema` from this module — none of the three may be
 * renamed or re-homed.
 *
 * `graph_throttled` is already a member of `ReadActionFailureCode`, so the
 * third arm is redundant by construction; it is written out because the
 * contract names it and because sync callers reason about throttling
 * explicitly.
 */
export type M365SyncFailureCode = ReadActionFailureCode | 'continuation_invalid' | 'graph_throttled';

/** Compile-time proof the hand-written enum and the contract type are one set. */
type _Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _AssertSyncFailureCodeParity: _Same<
  z.infer<typeof m365SyncFailureCodeSchema>,
  M365SyncFailureCode
> = true;
void _AssertSyncFailureCodeParity;

/**
 * The failure arm's key is `code`, NOT `errorCode`. The shipped interactive
 * `readActionResultSchema` uses `errorCode` and stays that way; the sync wire
 * contract in the overview fixes `code`, the API client's
 * `GraphReadExecutorFailure` re-exposes `code`, and W04 branches on `code`.
 * `.strict()` makes an errorCode-shaped body a parse failure rather than a
 * silently-undefined field.
 */
export const m365SyncActionFailureSchema = z.object({
  success: z.literal(false),
  code: m365SyncFailureCodeSchema,
  retryAfterSeconds: z.number().int().min(1).max(300).optional(),
}).strict();

export const m365SyncActionResponseSchema = z.union([
  m365SyncActionResultSchema,
  m365SyncActionFailureSchema,
]);

export type M365SyncActionResponse = z.infer<typeof m365SyncActionResponseSchema>;
