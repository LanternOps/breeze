import { z } from 'zod';

const guidSchema = z.string().guid();
// UPN or object id. Forbids quotes/whitespace/backslash so values can be
// spliced into Graph paths/$filter without escaping ambiguity (mirrors
// readActions.ts userIdOrUpnSchema).
const userIdOrUpnSchema = z.string().min(3).max(320).regex(/^[A-Za-z0-9._%+@-]+$/);
const reasonSchema = z.string().min(1).max(500);
const skuIdsSchema = z.array(guidSchema).min(1).max(20);
const displayTextSchema = z.string().min(1).max(256);
// Exchange auto-reply bodies are HTML-capable and can be long; bounded so a
// request can never exceed the actions executor's 16 KiB body cap.
const replyBodySchema = z.string().min(1).max(4000);
const isoInstantSchema = z.string().datetime();
// ISO 3166-1 alpha-2. Graph rejects anything else, and a license cannot be
// assigned to a user with no usageLocation.
const usageLocationSchema = z.string().regex(/^[A-Z]{2}$/);
const autoReplyStatusSchema = z.enum(['disabled', 'alwaysEnabled', 'scheduled']);
const externalAudienceSchema = z.enum(['none', 'contactsOnly', 'all']);

/**
 * Mutating actions (Operator Recipe Library spec §7.1). Every id here is an
 * AI tool target, an action-intent action name and a value in
 * M365_HEADLESS_ACTIONS; nothing else may be.
 */
export const M365_WRITE_ACTION_IDS = [
  'm365.user.disable',
  'm365.user.reset_password',
  'm365.user.revoke_sessions',
  'm365.user.license.remove',
  'm365.user.license.assign',
  'm365.group.membership.remove',
  'm365.group.membership.add',
  'm365.intune.device.retire',
  'm365.user.create',
  'm365.user.mailbox.auto_reply',
] as const;

/**
 * Read-only arms carried on the SAME executor union and route as the writes.
 * Why they are not read-executor actions: the `customer-graph-read` profile
 * holds no MailboxSettings.Read, and adding it would force a SECOND customer
 * re-consent on a second app registration — which the consent migration
 * (spec §7.2) exists to avoid. Kept out of M365_WRITE_ACTION_IDS so a probe
 * id can never be an AI tool target, an action-intent action name, or a
 * value in M365_HEADLESS_ACTIONS.
 */
export const M365_PROBE_ACTION_IDS = ['m365.user.mailbox.auto_reply.state'] as const;

export type M365WriteActionId = typeof M365_WRITE_ACTION_IDS[number];
export type M365ProbeActionId = typeof M365_PROBE_ACTION_IDS[number];
export type M365ExecutorActionId = M365WriteActionId | M365ProbeActionId;

export const m365WriteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('m365.user.disable'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.reset_password'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.revoke_sessions'),
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.license.remove'),
    userIdentifier: userIdOrUpnSchema,
    skuIds: skuIdsSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.license.assign'),
    userIdentifier: userIdOrUpnSchema,
    skuIds: skuIdsSchema,
    disabledPlanIds: z.array(guidSchema).max(50).optional(),
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.membership.remove'),
    groupId: guidSchema,
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.group.membership.add'),
    groupId: guidSchema,
    userIdentifier: userIdOrUpnSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.intune.device.retire'),
    // Intune managedDevice id. RETIRE only — full wipe is excluded from the
    // catalog by spec §7.1 and has no arm here by design.
    managedDeviceId: guidSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.create'),
    userPrincipalName: userIdOrUpnSchema,
    displayName: displayTextSchema,
    mailNickname: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]+$/),
    usageLocation: usageLocationSchema,
    reason: reasonSchema,
  }).strict(),
  z.object({
    type: z.literal('m365.user.mailbox.auto_reply'),
    userIdentifier: userIdOrUpnSchema,
    status: autoReplyStatusSchema,
    internalReplyMessage: replyBodySchema.optional(),
    externalReplyMessage: replyBodySchema.optional(),
    externalAudience: externalAudienceSchema.optional(),
    scheduledStartDateTime: isoInstantSchema.optional(),
    scheduledEndDateTime: isoInstantSchema.optional(),
    reason: reasonSchema,
  }).strict(),
  // Read-only probe arm (M365_PROBE_ACTION_IDS): no reason, because it changes nothing.
  z.object({
    type: z.literal('m365.user.mailbox.auto_reply.state'),
    userIdentifier: userIdOrUpnSchema,
  }).strict(),
]).superRefine((value, ctx) => {
  // z.discriminatedUnion rejects a ZodEffects member, so the auto-reply arm's
  // cross-field rule lives here instead of on the arm.
  if (value.type === 'm365.user.mailbox.auto_reply'
    && value.status === 'scheduled'
    && (value.scheduledStartDateTime === undefined || value.scheduledEndDateTime === undefined)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'scheduled auto-reply requires scheduledStartDateTime and scheduledEndDateTime',
    });
  }
});

/** Every arm the executor accepts: the mutating writes AND the read-only probe arm. */
export type M365WriteAction = z.infer<typeof m365WriteActionSchema>;
/** Only the mutating arms — what a tool, an intent or a recipe effect may carry. */
export type M365MutatingAction = Extract<M365WriteAction, { type: M365WriteActionId }>;
/** Only the read-only probe arms — reachable from the effect probes alone. */
export type M365ProbeAction = Extract<M365WriteAction, { type: M365ProbeActionId }>;

export function isM365ProbeActionId(id: string): id is M365ProbeActionId {
  return (M365_PROBE_ACTION_IDS as readonly string[]).includes(id);
}

// Compile-time tie between the id lists and the schema arms: adding an id
// without an arm (or an arm without an id) fails tsc here, not at runtime.
type ArmIdsMatch = [
  Exclude<M365WriteAction['type'], M365ExecutorActionId>,
  Exclude<M365ExecutorActionId, M365WriteAction['type']>,
] extends [never, never] ? true : false;
const ARM_IDS_MATCH: ArmIdsMatch = true;
void ARM_IDS_MATCH;

export const writeActionRequestSchema = z.object({
  correlationId: guidSchema,
  tenantId: guidSchema,
  // = the immutable action_intents.id; carried for audit correlation and as
  // the natural key for a future executor-side dedup store.
  idempotencyKey: z.string().min(1).max(200),
  action: m365WriteActionSchema,
}).strict();

export type WriteActionRequest = z.infer<typeof writeActionRequestSchema>;

export const writeActionFailureCodeSchema = z.enum([
  'credential_unavailable',
  'application_token_invalid',
  'user_not_found',
  'user_ambiguous',
  'tenant_mismatch',
  'graph_permission_missing',
  'graph_throttled',
  'graph_request_timeout',
  'graph_transport_failed',
  'graph_error',
  'invalid_action',
  // A requested SKU that is not yet assigned has no free seat
  // (prepaidUnits.enabled - consumedUnits <= 0), determined by a
  // /subscribedSkus pre-read — NO assignLicense call was made.
  'license_unavailable',
  // The group is dynamic-membership or role-assignable, so its members are not
  // directly editable. Determined by a group pre-read — NO members call was made.
  'unsupported_group_type',
  // The Intune managedDevice id does not resolve. Distinct from user_not_found
  // so a probe can tell "wrong device" from "wrong user".
  'device_not_found',
  // POST /users was rejected AND a follow-up read found a user with that
  // userPrincipalName. A rejection with no such user stays graph_error.
  'user_already_exists',
]);

export type WriteActionFailureCode = z.infer<typeof writeActionFailureCodeSchema>;

export const writeActionResultSchema = z.union([
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.disable'),
    userId: guidSchema,
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.reset_password'),
    userId: guidSchema,
    temporaryPassword: z.string().min(1).max(256),
    forceChangeNextSignIn: z.literal(true),
  }).strict(),
  z.object({ success: z.literal(true), action: z.literal('m365.user.revoke_sessions'), userId: guidSchema }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.license.remove'),
    userId: guidSchema,
    removedSkuIds: z.array(guidSchema),
    noop: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.license.assign'),
    userId: guidSchema,
    assignedSkuIds: z.array(guidSchema),
    noop: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.group.membership.remove'),
    userId: guidSchema,
    groupId: guidSchema,
    noop: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.group.membership.add'),
    userId: guidSchema,
    groupId: guidSchema,
    noop: z.boolean(),
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.intune.device.retire'),
    managedDeviceId: guidSchema,
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.create'),
    userId: guidSchema,
    userPrincipalName: z.string().min(3).max(320),
    temporaryPassword: z.string().min(1).max(256),
    forceChangeNextSignIn: z.literal(true),
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.mailbox.auto_reply'),
    userId: guidSchema,
    status: autoReplyStatusSchema,
  }).strict(),
  z.object({
    success: z.literal(true),
    action: z.literal('m365.user.mailbox.auto_reply.state'),
    userId: guidSchema,
    status: autoReplyStatusSchema,
    externalAudience: externalAudienceSchema,
    // Whether a message body is present at all — NEVER the body itself, which
    // may quote customer correspondence and has no business in an intent result.
    hasInternalReplyMessage: z.boolean(),
    hasExternalReplyMessage: z.boolean(),
    scheduledStartDateTime: z.string().datetime().nullable(),
    scheduledEndDateTime: z.string().datetime().nullable(),
  }).strict(),
  z.object({
    success: z.literal(false),
    errorCode: writeActionFailureCodeSchema,
    retryAfterSeconds: z.number().int().min(1).max(300).optional(),
  }).strict(),
]);

export type WriteActionResult = z.infer<typeof writeActionResultSchema>;

export type M365WriteIdempotencyClass = 'idempotent' | 'idempotent_by_probe' | 'non_idempotent';

/**
 * Spec §6.6 per-action idempotency class. There is no executor-side dedup
 * store and Graph takes no idempotency key, so every effect is
 * probe → write → probe; this class decides whether a repeat is safe.
 *   - idempotent: repeating the write converges on the same end state.
 *   - idempotent_by_probe: a repeat changes something (a cutoff instant, a
 *     reply body, a plan list), so repeat only when the probe says not done.
 *   - non_idempotent: never auto-repeated (a second call mints a second
 *     credential or a second object).
 */
export const M365_WRITE_ACTION_IDEMPOTENCY: Readonly<Record<M365WriteActionId, M365WriteIdempotencyClass>> = {
  'm365.user.disable': 'idempotent',
  'm365.user.reset_password': 'non_idempotent',
  'm365.user.revoke_sessions': 'idempotent_by_probe',
  'm365.user.license.remove': 'idempotent',
  'm365.user.license.assign': 'idempotent_by_probe',
  'm365.group.membership.remove': 'idempotent',
  'm365.group.membership.add': 'idempotent',
  'm365.intune.device.retire': 'idempotent',
  'm365.user.create': 'non_idempotent',
  'm365.user.mailbox.auto_reply': 'idempotent_by_probe',
};

/**
 * Microsoft Graph application roles each executor action needs, by role
 * VALUE (spec §7.1). Every value must be in the `customer-graph-actions`
 * manifest (profiles.test.ts pins that); the write ladder resolves each value
 * to the manifest's canonical (resource, appRoleId) assignment before
 * comparing it with observed grants.
 *
 * Sources (Microsoft Graph API reference, "Permissions" tables, Application row):
 * https://learn.microsoft.com/en-us/graph/permissions-reference
 *   - revokeSignInSessions: User.RevokeSessions.All is the only application
 *     permission (no higher-privileged alternative is available);
 *   - assignLicense: User.ReadWrite.All (higher-privileged, listed);
 *   - POST /users: User.ReadWrite.All (higher-privileged, listed);
 *   - DELETE/POST group members: GroupMember.ReadWrite.All;
 *   - managedDevice retire: DeviceManagementManagedDevices.PrivilegedOperations.All;
 *   - mailboxSettings GET/PATCH: MailboxSettings.ReadWrite;
 *   - GET /subscribedSkus (the seat pre-read): Organization.Read.All.
 */
export const M365_WRITE_ACTION_REQUIRED_ROLES: Readonly<Record<M365ExecutorActionId, readonly string[]>> = {
  'm365.user.disable': ['User.ReadWrite.All'],
  'm365.user.reset_password': ['User.ReadWrite.All', 'User-PasswordProfile.ReadWrite.All'],
  // User.ReadWrite.All covers the user-id resolution read.
  'm365.user.revoke_sessions': ['User.ReadWrite.All', 'User.RevokeSessions.All'],
  'm365.user.license.remove': ['User.ReadWrite.All'],
  'm365.user.license.assign': ['User.ReadWrite.All', 'Organization.Read.All'],
  'm365.group.membership.remove': ['GroupMember.ReadWrite.All'],
  'm365.group.membership.add': ['GroupMember.ReadWrite.All'],
  'm365.intune.device.retire': ['DeviceManagementManagedDevices.PrivilegedOperations.All'],
  'm365.user.create': ['User.ReadWrite.All'],
  'm365.user.mailbox.auto_reply': ['MailboxSettings.ReadWrite'],
  'm365.user.mailbox.auto_reply.state': ['MailboxSettings.ReadWrite'],
};
