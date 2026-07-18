import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace so values can be embedded in
// $filter expressions without escaping ambiguity.
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const searchTermSchema = z.string().min(1).max(120).regex(/^[^"'\\]+$/);
// Graph composite site id: host,siteCollectionGuid-ish,siteGuid-ish (comma-separated tokens).
const siteIdSchema = z.string().min(1).max(300).regex(/^[A-Za-z0-9.,_-]+$/);

const pageSize = (max: number) => z.number().int().min(1).max(max).optional();

export const M365_READ_ACTION_IDS = [
  'm365.user.list', 'm365.user.get', 'm365.signins.list',
  'm365.intune.device.list', 'm365.intune.device.get',
  'm365.group.list', 'm365.group.get', 'm365.group.members.list',
  'm365.org.get', 'm365.org.skus.list',
  'm365.sites.list', 'm365.site.get',
] as const;

export type M365ReadActionId = typeof M365_READ_ACTION_IDS[number];

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
};

export const m365ReadActionSchema = z.discriminatedUnion('type', [
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
]);

export type M365ReadAction = z.infer<typeof m365ReadActionSchema>;

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

const readActionItemSchema = z.record(z.unknown());

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
