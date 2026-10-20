/**
 * Technician client for caller verification (#6354 W04).
 *
 * Types mirror the shipped W01 HTTP projections in
 * apps/api/src/routes/callerVerification.ts (every success body is `{data}`).
 * Org-scoped calls pin the org named by the path (`orgIdOverride`) so a
 * different ambient org switcher selection can never be injected; partner
 * calls inject no org. Every mutation runs through `runAction`.
 *
 * Not covered here: workstation device suggestions (W02) and the
 * administrative step-up route (W05) — neither is mounted yet.
 */
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { i18n } from '@/lib/i18n';

export type CallerVerificationAction = 'reset_password' | 'disable_user';
export type CallerVerificationActionScope = CallerVerificationAction | 'any';
export type CallerVerificationMethod = 'workstation' | 'sms' | 'email' | 'callback_attestation' | 'administrative_stepup';
export type StartableMethod = Exclude<CallerVerificationMethod, 'administrative_stepup'>;
export type CallerVerificationStatus =
  | 'pending' | 'verified' | 'rejected_by_user' | 'wrong_choice' | 'expired' | 'undeliverable' | 'cancelled' | 'revoked';

export interface VerificationView {
  id: string; orgId: string; contactId: string; targetContactId: string | null;
  method: CallerVerificationMethod; status: CallerVerificationStatus; tier: number; tierReason: string;
  actionScope: CallerVerificationActionScope; targetLabel: string | null; technicianLabel: string; initiatedByUserId: string;
  expiresAt: string; decidedAt: string | null; consumedAt: string | null; ticketRef: string | null; ticketNumber: string | null;
  destinationRedacted: string | null; deviceHostname: string | null; osUsername: string | null; createdAt: string;
  /** Present only for the technician who started the challenge. */
  secrets?: { matchValue: string; decoyValues: string[]; reverseCode: string };
}

export type VerificationDetails = VerificationView & {
  remainingAttempts: number | null;
  /** Grant freshness (verified rows only) — NOT the challenge expiry. */
  usableUntil: string | null;
  incidentId: string | null;
  consumedAction: CallerVerificationAction | null;
  /** Status of the consumed action intent ('failed' = verification used, action failed). Optional until every consumer supplies it. */
  consumedIntentStatus?: 'pending_approval' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'expired' | 'cancelled' | null;
  undeliverableReason: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' | 'sms_failed' | 'email_failed' | null;
};

export interface MethodAvailability {
  method: CallerVerificationMethod; available: boolean; tier: number; reason: string;
  unavailableReason?: 'method_disabled' | 'no_destination' | 'helper_outdated' | 'no_binding' | 'administrative_disabled' | 'feature_disabled';
}

export interface PolicyValues {
  requiredTierResetPassword: number; requiredTierDisableUser: number; disableUserAuthorizerRoles: string[];
  verificationTtlMinutes: number; allowedMethods: Array<Exclude<StartableMethod, never>>;
  workstationTimeoutSeconds: number; destinationMinAgeDays: number; requireAttestedDestination: boolean;
  requireTicket: boolean; allowCrossTechnicianUse: boolean; allowAdministrativeDisable: boolean;
  maxAttemptsPerHour: number; coolingOffHours: number;
}
export type EffectiveCallerVerificationPolicy = PolicyValues & {
  provenance: Record<string, 'default' | 'partner' | 'org'>; ignored: string[];
};
/** null = inherit (partner baseline or code default). */
export type PolicyDraft = { [K in keyof PolicyValues]: PolicyValues[K] | null };
export interface PolicyResponse {
  /** Highest tier the server can currently satisfy (2 while the workstation tier is dark). */
  maxAchievableTier?: 2 | 3;
  /** Per-action caps; disable_user can reach tier 3 via administrative step-up even while the workstation tier is dark. */
  maxAchievableTierResetPassword?: 2 | 3;
  maxAchievableTierDisableUser?: 2 | 3;
  /** The owner's own stored row (may carry extra server columns), null when none. */
  row: Partial<PolicyDraft> | null;
  defaults: PolicyValues;
  /** Resolved partner baseline before any org tightening. */
  baseline: PolicyValues;
  effective: EffectiveCallerVerificationPolicy;
}
export type Owner = { ownerScope: 'partner' } | { ownerScope: 'organization'; orgId: string };

export interface BindingView {
  id: string; entraTenantId: string | null; entraOid: string | null; upnSnapshot: string | null;
  osPrincipal: string | null; osUsername: string | null;
  source: 'directory_sync' | 'technician_attested' | 'observed_login';
  establishedAt: string; attestedAt: string | null; revokedAt: string | null;
}
export interface DestinationView {
  id: string; kind: 'email' | 'mobile'; valueRedacted: string; setAt: string;
  source: 'technician' | 'import' | 'inbound_email' | 'ai_tool' | 'portal_self_service';
  attestedAt: string | null; established: boolean;
}
export interface ContactHistory { rows: VerificationDetails[]; fencedUntil: string | null; bindings: BindingView[]; destinations: DestinationView[] }
export interface TicketVerification { row: VerificationDetails | null; isFresh: boolean; isConsumed: boolean }
export interface DirectoryUser { entraTenantId: string; entraOid: string; upn: string; displayName: string }
export interface DirectorySearch { available: boolean; users: DirectoryUser[]; truncated: boolean }
export interface DirectorySyncResult { imported: number; revoked: number; complete: boolean }

export interface StartInput {
  orgId: string; contactId: string; targetContactId?: string; method: StartableMethod;
  actionScope: CallerVerificationActionScope; deviceId?: string; username?: string; ticketId?: string; note?: string;
}

const seg = encodeURIComponent;
const ns = 'callerVerificationTech';

function orgPath(orgId: string, suffix: string, query?: Record<string, string>): string {
  const qs = query ? `?${new URLSearchParams(query)}` : '';
  return `/orgs/${seg(orgId)}/${suffix}${qs}`;
}

function unwrapData<T>(body: unknown): T {
  if (!body || typeof body !== 'object' || !('data' in body)) throw new Error('Missing API data envelope');
  return (body as { data: T }).data;
}

function requireFields<T extends object>(value: T, fields: readonly (keyof T)[]): T {
  if (!value || typeof value !== 'object' || fields.some((key) => !(key in value) || value[key] === undefined)) {
    throw new Error('Incomplete caller verification projection');
  }
  return value;
}

const verification = (v: VerificationDetails): VerificationDetails =>
  requireFields(v, ['id', 'status', 'remainingAttempts', 'usableUntil', 'incidentId', 'consumedAction', 'undeliverableReason']);
const historyShape = (v: ContactHistory): ContactHistory => {
  requireFields(v, ['rows', 'fencedUntil', 'bindings', 'destinations']);
  v.rows.forEach(verification);
  return v;
};
const ticketShape = (v: TicketVerification): TicketVerification => {
  requireFields(v, ['row', 'isFresh', 'isConsumed']);
  if (v.row) verification(v.row);
  return v;
};
const policyShape = (v: PolicyResponse): PolicyResponse => {
  requireFields(v, ['row', 'defaults', 'baseline', 'effective']);
  if (!v.defaults || !v.baseline || !v.effective) throw new Error('Incomplete caller verification projection');
  return v;
};
const directoryShape = (v: DirectorySearch): DirectorySearch => {
  requireFields(v, ['available', 'users', 'truncated']);
  v.users.forEach((u) => requireFields(u, ['entraTenantId', 'entraOid', 'upn', 'displayName']));
  return v;
};

/** Human copy for a server refusal token; undefined lets runAction keep its own message. */
export function refusalMessage(token: string): string | undefined {
  if (token === 'Rate limited') return i18n.t('callerVerificationTech:errors.rateLimited');
  if (token === 'MFA_REQUIRED' || token === 'MFA required') return i18n.t('callerVerificationTech:errors.mfaRequired');
  const key = `${ns}:errors.${token}`;
  // i18n-dynamic: server error codes are runtime values.
  return i18n.exists(key) ? i18n.t(/* i18n-dynamic */ key) : undefined;
}

async function read<T>(path: string, pin: string | null, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithAuth(path, { method: 'GET', cache: 'no-store', signal, orgIdOverride: pin });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const code = body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
    throw new ActionError(i18n.t('callerVerificationTech:errors.loadFailed'), response.status, typeof code === 'string' ? code : undefined, body);
  }
  return unwrapData<T>(await response.json());
}

function mutate<T>(
  path: string, pin: string | null, method: 'POST' | 'PUT' | 'DELETE', body?: unknown,
  validate: (value: T) => T = (value) => value, successKey?: string,
): Promise<T> {
  return runAction<T>({
    request: () => fetchWithAuth(path, { method, orgIdOverride: pin, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    errorFallback: i18n.t('callerVerificationTech:errors.saveFailed'),
    ...(successKey ? { successMessage: i18n.t(/* i18n-dynamic */ `${ns}:${successKey}`) } : {}),
    parseSuccess: (data) => validate(unwrapData<T>(data)),
    friendly: (token) => refusalMessage(token),
  });
}

// --- Verifications ----------------------------------------------------------

/**
 * Start is validated leniently (id + status only): the server has already
 * created the challenge and may have delivered it, so a missing projection
 * field must not read as a failed start and invite a duplicate attempt. The
 * modal's first poll then reads the full projection.
 */
export function startVerification({ orgId, ...body }: StartInput): Promise<VerificationDetails> {
  return mutate(orgPath(orgId, 'caller-verifications'), orgId, 'POST', body, (v: VerificationDetails) => requireFields(v, ['id', 'status']));
}
export function getVerification(orgId: string, id: string, signal?: AbortSignal): Promise<VerificationDetails> {
  return read<VerificationDetails>(orgPath(orgId, `caller-verifications/${seg(id)}`), orgId, signal).then(verification);
}
export function cancelVerification(orgId: string, id: string): Promise<VerificationDetails> {
  return mutate(orgPath(orgId, `caller-verifications/${seg(id)}/cancel`), orgId, 'POST', undefined, verification);
}
export function attestVerification(orgId: string, id: string, note: string): Promise<VerificationDetails> {
  return mutate(orgPath(orgId, `caller-verifications/${seg(id)}/attest`), orgId, 'POST', { note }, verification, 'toasts.attested');
}

// --- Per contact --------------------------------------------------------------

export function contactHistory(orgId: string, contactId: string, signal?: AbortSignal): Promise<ContactHistory> {
  return read<ContactHistory>(orgPath(orgId, `contacts/${seg(contactId)}/caller-verifications`), orgId, signal).then(historyShape);
}
export function methodsForContact(
  orgId: string, contactId: string, actionScope: CallerVerificationActionScope, signal?: AbortSignal,
): Promise<MethodAvailability[]> {
  return read<MethodAvailability[]>(orgPath(orgId, `contacts/${seg(contactId)}/caller-verifications/methods`, { actionScope }), orgId, signal)
    .then((rows) => {
      if (!Array.isArray(rows)) throw new Error('Incomplete caller verification projection');
      rows.forEach((r) => requireFields(r, ['method', 'available', 'tier']));
      return rows;
    });
}
export function freshForTicket(orgId: string, ticketId: string, signal?: AbortSignal): Promise<TicketVerification> {
  return read<TicketVerification>(orgPath(orgId, `tickets/${seg(ticketId)}/caller-verification`), orgId, signal).then(ticketShape);
}
export function fenceOverride(orgId: string, contactId: string, reason: string): Promise<{ ok: true }> {
  return mutate(orgPath(orgId, `contacts/${seg(contactId)}/caller-verifications/fence-override`), orgId, 'POST', { reason }, undefined, 'toasts.fenceOverridden');
}
export function attestDestination(orgId: string, contactId: string, id: string): Promise<{ id: string; attestedAt: string }> {
  return mutate(orgPath(orgId, `contacts/${seg(contactId)}/caller-verification-destinations/${seg(id)}/attest`), orgId, 'POST', undefined, undefined, 'toasts.destinationAttested');
}
export function bindContact(orgId: string, contactId: string, user: DirectoryUser): Promise<unknown> {
  const { entraTenantId, entraOid, upn } = user;
  return mutate(orgPath(orgId, `contacts/${seg(contactId)}/caller-verification-bindings`), orgId, 'POST', { entraTenantId, entraOid, upn }, undefined, 'toasts.bound');
}
export function unbindContact(orgId: string, contactId: string, bindingId: string): Promise<{ ok: true }> {
  return mutate(orgPath(orgId, `contacts/${seg(contactId)}/caller-verification-bindings/${seg(bindingId)}`), orgId, 'DELETE', undefined, undefined, 'toasts.unbound');
}

// --- Directory ----------------------------------------------------------------

export function directoryUsers(orgId: string, search: string, signal?: AbortSignal): Promise<DirectorySearch> {
  return read<DirectorySearch>(orgPath(orgId, 'caller-verification-directory-users', { search }), orgId, signal).then(directoryShape);
}
export function syncDirectory(orgId: string, mappings: Array<{ contactId: string; entraOid: string }>): Promise<DirectorySyncResult> {
  return mutate(orgPath(orgId, 'caller-verification-directory-sync'), orgId, 'POST', { mappings }, undefined, 'toasts.synced');
}

// --- Policy -------------------------------------------------------------------

const policyTarget = (owner: Owner): [string, string | null] =>
  owner.ownerScope === 'partner' ? ['/partner/caller-verification-policy', null] : [orgPath(owner.orgId, 'caller-verification-policy'), owner.orgId];

export function getPolicy(owner: Owner, signal?: AbortSignal): Promise<PolicyResponse> {
  const [path, pin] = policyTarget(owner);
  return read<PolicyResponse>(path, pin, signal).then(policyShape);
}
export function putPolicy(owner: Owner, draft: PolicyDraft): Promise<PolicyResponse> {
  const [path, pin] = policyTarget(owner);
  return mutate(path, pin, 'PUT', draft, policyShape, 'toasts.policySaved');
}

// --- Contacts (existing org-contacts list, used by the requester picker) -------

export interface ContactOption { id: string; name: string | null; email: string | null; phone: string | null; siteId: string | null }
export async function contactsPage(orgId: string, page: number, signal?: AbortSignal): Promise<{ data: ContactOption[]; total: number }> {
  const response = await fetchWithAuth(`/orgs/organizations/${seg(orgId)}/contacts?${new URLSearchParams({ page: String(page), limit: '100' })}`,
    { method: 'GET', signal, orgIdOverride: orgId });
  if (!response.ok) throw new ActionError(i18n.t('callerVerificationTech:errors.loadFailed'), response.status);
  const body = await response.json() as { data?: ContactOption[]; pagination?: { total?: number } };
  if (!Array.isArray(body.data)) throw new Error('Missing API data envelope');
  return { data: body.data, total: body.pagination?.total ?? body.data.length };
}
