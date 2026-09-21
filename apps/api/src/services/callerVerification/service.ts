/**
 * Caller verification workflow service (#6354 W01).
 *
 * Initiation (`start`, `createAdministrative`), private read models (`get`,
 * `listForContact`, `methodsForContact`, `freshForTicket`) and decisions
 * (`cancel`, `attest`, `applyDecision`). Every authenticated entry point
 * re-checks org/site reach through `reachableContact` independently of the
 * router. Verification rows are durable work records: delivery happens only
 * after commit (the publisher drives `ports.deliver`), and challenge secrets
 * are an explicit initiator-only projection.
 *
 * Lock order inside a transaction: identity namespace → contact → subject
 * bindings. The attempt count and the INSERT share the contact lock so the
 * hourly cap cannot be raced.
 */
import { randomInt, randomBytes, createHash } from 'node:crypto';
import { and, eq, desc, sql } from 'drizzle-orm';
import { db, assertInTransaction, getCurrentDbAccessContext, withSystemDbAccessContext } from '../../db';
import { callerVerifications as v, callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { tickets } from '../../db/schema/portal';
import { devices } from '../../db/schema/devices';
import { incidents } from '../../db/schema/incidentResponse';
import { actionIntents } from '../../db/schema/actionIntents';
import { callerVerificationEnabled } from '../../config/env';
import type {
  CallerVerificationAction, CallerVerificationActor, CallerVerificationMethod, CallerVerificationStatus,
  CallerVerificationActionScope, VerificationRow,
} from './types';
import { CallerVerificationValidationError as Invalid } from './errors';
import { getEffectivePolicy } from './policy';
import { reachableContact, requesterAuthorized } from './access';
import { bindingsForContact } from './subjects';
import { currentDestination, isEstablished, normalizeDestination } from './destinations';
import { computeTier } from './tiers';
import { lockContact, withSubjectLocks } from './locks';
import { callerVerificationPorts as ports } from './ports';
import { fencedUntil } from './gate';
import { recordEffect } from './effects';
import { handleRejection } from './rejection';

// ---------------------------------------------------------------------------
// Cross-wave contracts (fixed by the index plan)
// ---------------------------------------------------------------------------

export interface StartInput {
  orgId: string;
  contactId: string;
  targetContactId?: string;
  method: Exclude<CallerVerificationMethod, 'administrative_stepup'>;
  actionScope: CallerVerificationActionScope;
  deviceId?: string;
  username?: string;
  ticketId?: string;
  note?: string;
}

export interface VerificationView {
  id: string;
  orgId: string;
  contactId: string;
  targetContactId: string | null;
  method: CallerVerificationMethod;
  status: CallerVerificationStatus;
  tier: number;
  tierReason: string;
  actionScope: CallerVerificationActionScope;
  targetLabel: string | null;
  technicianLabel: string;
  initiatedByUserId: string;
  expiresAt: string;
  decidedAt: string | null;
  consumedAt: string | null;
  ticketRef: string | null;
  ticketNumber: string | null;
  destinationRedacted: string | null;
  deviceHostname: string | null;
  osUsername: string | null;
  createdAt: string;
  /** Initiator only. */
  secrets?: { matchValue: string; decoyValues: string[]; reverseCode: string };
}

export interface MethodAvailability {
  method: CallerVerificationMethod;
  available: boolean;
  tier: number;
  reason: string;
  unavailableReason?: 'method_disabled' | 'no_destination' | 'helper_outdated' | 'no_binding' | 'administrative_disabled' | 'feature_disabled';
}

/** Additive HTTP projection (W04 consumes; W05 retains). */
export type VerificationDetails = VerificationView & {
  remainingAttempts: number | null;
  usableUntil: string | null;
  incidentId: string | null;
  consumedAction: CallerVerificationAction | null;
  undeliverableReason: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' | 'sms_failed' | 'email_failed' | null;
};

export type Decision =
  | { kind: 'choice'; value: string }
  | { kind: 'not_me' }
  | { kind: 'timeout' }
  | { kind: 'undeliverable'; reason: string };

const STARTABLE: Array<Exclude<CallerVerificationMethod, 'administrative_stepup'>> = ['workstation', 'sms', 'email', 'callback_attestation'];
const UNDELIVERABLE_REASONS = ['no_session_for_user', 'session_not_console', 'helper_outdated', 'sms_failed', 'email_failed'] as const;

// ---------------------------------------------------------------------------
// Secrets and projections
// ---------------------------------------------------------------------------

export function challengeSecrets(): { matchValue: string; decoyValues: string[]; reverseCode: string } {
  const choices = new Set<string>();
  while (choices.size < 3) choices.add(String(randomInt(10, 100)));
  const [matchValue, ...decoyValues] = [...choices];
  return { matchValue: matchValue!, decoyValues, reverseCode: String(randomInt(0, 10000)).padStart(4, '0') };
}

export function view(r: VerificationRow, userId: string | null, targetContactId: string | null): VerificationView {
  return {
    id: r.id, orgId: r.orgId, contactId: r.contactId, targetContactId, method: r.method, status: r.status, tier: r.tier, tierReason: r.tierReason,
    actionScope: r.actionScope, targetLabel: r.targetLabel, technicianLabel: r.technicianLabel, initiatedByUserId: r.initiatedByUserId,
    expiresAt: r.expiresAt.toISOString(), decidedAt: r.decidedAt?.toISOString() ?? null, consumedAt: r.consumedAt?.toISOString() ?? null,
    ticketRef: r.ticketRef, ticketNumber: r.ticketNumber, destinationRedacted: r.destinationRedacted, deviceHostname: r.deviceHostname,
    osUsername: r.osUsername, createdAt: r.createdAt.toISOString(),
    ...(userId !== null && r.initiatedByUserId === userId
      ? { secrets: { matchValue: r.matchValue, decoyValues: r.decoyValues, reverseCode: r.reverseCode } }
      : {}),
  };
}

export function verificationDetails(
  r: VerificationRow, userId: string | null, targetId: string | null,
  policy: Awaited<ReturnType<typeof getEffectivePolicy>>, attempts: number, incidentId: string | null, actionName: string | null,
): VerificationDetails {
  const reason = UNDELIVERABLE_REASONS.find((value) => value === r.reason) ?? null;
  const proofAt = r.method === 'administrative_stepup' ? r.stepupVerifiedAt : r.decidedAt;
  return {
    ...view(r, userId, targetId),
    remainingAttempts: Math.max(0, policy.maxAttemptsPerHour - attempts),
    usableUntil: r.status === 'verified' && proofAt ? new Date(proofAt.getTime() + policy.verificationTtlMinutes * 60000).toISOString() : null,
    incidentId,
    // Never inferred from actionScope='any': a deleted/moved intent yields null.
    consumedAction: !r.consumedAt ? null : actionName === 'm365_reset_password' ? 'reset_password' : actionName === 'm365_disable_user' ? 'disable_user' : null,
    undeliverableReason: r.status === 'undeliverable' ? reason : null,
  };
}

export async function projectVerification(r: VerificationRow, userId: string | null, targetId: string | null): Promise<VerificationDetails> {
  const policy = await getEffectivePolicy(r.orgId);
  const [attempts] = await db.select({ count: sql<number>`count(*)::int` }).from(v)
    .where(and(eq(v.orgId, r.orgId), eq(v.contactId, r.contactId), sql`${v.createdAt}>now()-interval '1 hour'`));
  const [incident] = await db.select({ id: incidents.id }).from(incidents)
    .where(and(eq(incidents.orgId, r.orgId), eq(incidents.sourceType, 'caller_verification'), eq(incidents.sourceRef, r.id))).limit(1);
  const [intent] = r.consumedAt && r.consumedIntentRef
    ? await db.select({ actionName: actionIntents.actionName }).from(actionIntents)
      .where(and(eq(actionIntents.orgId, r.orgId), eq(actionIntents.id, r.consumedIntentRef))).limit(1)
    : [];
  return verificationDetails(r, userId, targetId, policy, Number(attempts?.count ?? 0), incident?.id ?? null, intent?.actionName ?? null);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadVerification(orgId: string, id: string): Promise<VerificationRow> {
  const [r] = await db.select().from(v).where(and(eq(v.orgId, orgId), eq(v.id, id))).limit(1);
  if (!r) throw new Invalid('not_found', 'Verification not found');
  return r;
}

async function targetContact(r: VerificationRow): Promise<string | null> {
  if (!r.targetBindingId) return null;
  const [t] = await db.select().from(b).where(and(eq(b.id, r.targetBindingId), eq(b.orgId, r.orgId))).limit(1);
  return t?.contactId ?? null;
}

export async function get(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationDetails> {
  const r = await loadVerification(orgId, id);
  await reachableContact(actor, orgId, r.contactId);
  const target = await targetContact(r);
  if (target) await reachableContact(actor, orgId, target);
  return projectVerification(r, actor.userId, target);
}

export async function methodsForContact(
  actor: CallerVerificationActor, orgId: string, contactId: string, actionScope: CallerVerificationActionScope,
): Promise<MethodAvailability[]> {
  const contact = await reachableContact(actor, orgId, contactId);
  const p = await getEffectivePolicy(orgId);
  const bindings = await bindingsForContact(orgId, contactId);
  const rows: MethodAvailability[] = [];
  for (const method of STARTABLE) {
    const kind = method === 'sms' ? 'mobile' : method === 'email' ? 'email' : null;
    const destination = kind ? await currentDestination(orgId, contactId, kind) : null;
    const tier = computeTier({ method, boundPrincipal: bindings.some((r) => !!r.osPrincipal), destinationEstablished: !!destination && isEstablished(destination, p), policy: p });
    let unavailableReason: MethodAvailability['unavailableReason'];
    if (!callerVerificationEnabled()) unavailableReason = 'feature_disabled';
    else if (!p.allowedMethods.includes(method)) unavailableReason = 'method_disabled';
    else if (actionScope !== 'any' && !bindings.some((r) => !!r.entraOid)) unavailableReason = 'no_binding';
    else if (kind && (!destination || !normalizeDestination(kind, contact[kind]))) unavailableReason = 'no_destination';
    else if (method !== 'callback_attestation' && !(await ports.available(method, orgId))) unavailableReason = method === 'workstation' ? 'helper_outdated' : 'method_disabled';
    rows.push({ method, available: !unavailableReason, ...tier, ...(unavailableReason ? { unavailableReason } : {}) });
  }
  return rows;
}

async function assertTicketDeviceReach(actor: CallerVerificationActor, orgId: string, deviceId: string | null): Promise<void> {
  if (!deviceId) return;
  const [device] = await db.select().from(devices).where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId))).limit(1);
  if (!device || (actor.allowedSiteIds !== null && (!device.siteId || !actor.allowedSiteIds.includes(device.siteId)))) {
    throw new Invalid('not_found', 'Ticket not found');
  }
}

export async function listForContact(
  actor: CallerVerificationActor, orgId: string, contactId: string,
): Promise<{ rows: VerificationDetails[]; fencedUntil: string | null }> {
  await reachableContact(actor, orgId, contactId);
  const p = await getEffectivePolicy(orgId);
  const records = await db.select().from(v).where(and(eq(v.orgId, orgId), eq(v.contactId, contactId))).orderBy(desc(v.createdAt)).limit(50);
  const rows: VerificationDetails[] = [];
  for (const r of records) {
    const target = await targetContact(r);
    if (target) await reachableContact(actor, orgId, target);
    rows.push(await projectVerification(r, actor.userId, target));
  }
  return { rows, fencedUntil: (await fencedUntil(orgId, contactId, p))?.toISOString() ?? null };
}

/** Ticket badge read — descriptive only; the gate rechecks tier and subject. */
export async function freshForTicket(
  actor: CallerVerificationActor, orgId: string, ticketId: string,
): Promise<{ row: VerificationDetails | null; isFresh: boolean; isConsumed: boolean }> {
  const [ticket] = await db.select().from(tickets).where(and(eq(tickets.id, ticketId), eq(tickets.orgId, orgId))).limit(1);
  if (!ticket?.requesterContactId || ticket.deletedAt) throw new Invalid('not_found', 'Ticket not found');
  await assertTicketDeviceReach(actor, orgId, ticket.deviceId);
  const history = await listForContact(actor, orgId, ticket.requesterContactId);
  const p = await getEffectivePolicy(orgId);
  const [ticketRow] = await db.select().from(v)
    .where(and(eq(v.orgId, orgId), eq(v.ticketRef, ticketId), eq(v.contactId, ticket.requesterContactId)))
    .orderBy(desc(v.createdAt)).limit(1);
  const row = ticketRow ? await get(actor, orgId, ticketRow.id) : history.rows[0] ?? null;
  return {
    row,
    isFresh: !!row && row.status === 'verified' && !history.fencedUntil && !!row.decidedAt && Date.parse(row.decidedAt) > Date.now() - p.verificationTtlMinutes * 60000,
    isConsumed: !!row?.consumedAt,
  };
}

// ---------------------------------------------------------------------------
// Initiation
// ---------------------------------------------------------------------------

export async function start(actor: CallerVerificationActor, input: StartInput): Promise<VerificationDetails> {
  if (!callerVerificationEnabled()) throw new Invalid('feature_disabled', 'Caller verification is disabled');
  assertInTransaction('startCallerVerification');
  const { orgId, contactId } = input;
  const requester = await reachableContact(actor, orgId, contactId);
  const target = await reachableContact(actor, orgId, input.targetContactId ?? contactId);
  const p = await getEffectivePolicy(orgId);
  const rb = (await bindingsForContact(orgId, contactId)).filter((r) => r.entraOid);
  const tb = (await bindingsForContact(orgId, target.id)).filter((r) => r.entraOid);
  if (input.actionScope !== 'any' && (rb.length !== 1 || tb.length !== 1)) throw new Invalid('subject_unmatched', 'Exactly one canonical binding is required');
  if (!requesterAuthorized(input.actionScope, rb[0] ?? null, tb[0] ?? null, requester, p.disableUserAuthorizerRoles)) {
    throw new Invalid('requester_not_authorized', 'Requester cannot authorize this target');
  }
  const methods = await methodsForContact(actor, orgId, contactId, input.actionScope);
  const method = methods.find((m) => m.method === input.method)!;
  if (!method.available) throw new Invalid(method.unavailableReason!, 'Method unavailable');

  let ticket: typeof tickets.$inferSelect | undefined;
  if (p.requireTicket && !input.ticketId) throw new Invalid('ticket_required', 'A ticket is required');
  if (input.ticketId) {
    [ticket] = await db.select().from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.orgId, orgId))).limit(1);
    if (!ticket || ticket.deletedAt || ticket.requesterContactId !== contactId) throw new Invalid('not_found', 'Ticket not found');
    await assertTicketDeviceReach(actor, orgId, ticket.deviceId);
  }
  let device: typeof devices.$inferSelect | undefined;
  if (input.deviceId) {
    // Share-locked so a concurrent org move waits for this start to commit
    // (device lock before contact/subject locks, matching moveOrg's order).
    [device] = await db.select().from(devices).where(and(eq(devices.id, input.deviceId), eq(devices.orgId, orgId))).limit(1).for('share');
    if (!device || (actor.allowedSiteIds !== null && (!device.siteId || !actor.allowedSiteIds.includes(device.siteId)))) {
      throw new Invalid('not_found', 'Device not found');
    }
  }
  if (input.method === 'workstation' && (!device || !input.username)) throw new Invalid('device_required', 'Workstation requires device and username');

  await lockContact(orgId, contactId);
  return withSubjectLocks(db, [rb[0]?.id ?? null, tb[0]?.id ?? null], async () => {
    if ((await fencedUntil(orgId, contactId, p)) || (await fencedUntil(orgId, target.id, p))) throw new Invalid('contact_fenced', 'Contact is fenced');
    // Re-read under locks.
    const currentR = (await bindingsForContact(orgId, contactId)).find((r) => r.id === rb[0]?.id) ?? null;
    const currentT = (await bindingsForContact(orgId, target.id)).find((r) => r.id === tb[0]?.id) ?? null;
    const currentRequester = await reachableContact(actor, orgId, contactId);
    await reachableContact(actor, orgId, target.id);
    if (!requesterAuthorized(input.actionScope, currentR, currentT, currentRequester, p.disableUserAuthorizerRoles)) {
      throw new Invalid('requester_not_authorized', 'Requester changed');
    }
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(v)
      .where(and(eq(v.orgId, orgId), eq(v.contactId, contactId), sql`${v.createdAt}>now()-interval '1 hour'`));
    if (count! >= p.maxAttemptsPerHour) throw new Invalid('attempt_cap', 'Contact attempt limit reached');
    const dest = input.method === 'sms' || input.method === 'email' ? await currentDestination(orgId, contactId, input.method === 'sms' ? 'mobile' : 'email') : null;
    // The clear token exists only in memory for the delivery port; the row keeps its hash.
    const token = dest ? randomBytes(32).toString('base64url') : null;
    const secret = challengeSecrets();
    const now = new Date();
    const computed = computeTier({ method: input.method, boundPrincipal: false, destinationEstablished: !!dest && isEstablished(dest, p), policy: p });
    const expiresMs = input.method === 'callback_attestation' ? 0 : input.method === 'workstation' ? p.workstationTimeoutSeconds * 1000 : 600000;
    const [row] = await db.insert(v).values({
      orgId, contactId,
      requesterBindingId: currentR?.id ?? null, targetBindingId: currentT?.id ?? null,
      targetEntraTenantId: currentT?.entraTenantId ?? null, targetEntraOid: currentT?.entraOid ?? null,
      initiatedByUserId: actor.userId, technicianLabel: actor.displayName, actionScope: input.actionScope,
      targetLabel: currentT?.upnSnapshot ?? target.name, method: input.method, status: 'pending',
      tier: computed.tier, tierReason: computed.reason, ...secret,
      challengeTokenHash: token ? createHash('sha256').update(token).digest('hex') : null,
      destinationId: dest?.id ?? null, destinationRedacted: dest?.valueRedacted ?? null,
      workstationDeviceRef: device?.id ?? null, deviceHostname: device?.hostname ?? null, osUsername: input.username ?? null,
      ticketRef: ticket?.id ?? null, ticketNumber: (ticket?.internalNumber ?? ticket?.ticketNumber)?.slice(0, 32) ?? null,
      attemptNo: count! + 1, expiresAt: new Date(now.getTime() + expiresMs), attestationNote: input.note ?? null,
    }).returning();
    if (input.method !== 'callback_attestation') await ports.prepare(row!, token);
    await recordEffect(row!, 'started', actor.userId);
    return projectVerification(row!, actor.userId, target.id);
  });
}

/**
 * W05 administrative factory: an interactive step-up proof (consumed through
 * the injected port) authorizes a disable_user grant without a caller
 * challenge. The contact lock, hourly count and cap-BEFORE-proof-consumption
 * are implemented invariants; only the proof adapter is a W05 seam.
 */
export async function createAdministrative(
  actor: CallerVerificationActor,
  input: { orgId: string; targetContactId: string; reason: string; stepUpGrantId: string },
): Promise<VerificationDetails> {
  if (!callerVerificationEnabled()) throw new Invalid('feature_disabled', 'Caller verification is disabled');
  if (input.reason.trim().length < 20) throw new Invalid('invalid_reason', 'Administrative reason must contain at least 20 characters');
  const target = await reachableContact(actor, input.orgId, input.targetContactId);
  const p = await getEffectivePolicy(input.orgId);
  if (!p.allowAdministrativeDisable) throw new Invalid('administrative_disabled', 'Administrative disable is disabled');
  const bindings = (await bindingsForContact(input.orgId, target.id)).filter((r) => r.entraOid && r.entraTenantId);
  if (bindings.length !== 1) throw new Invalid('subject_unmatched', 'Canonical target required');
  const binding = bindings[0]!;
  await lockContact(input.orgId, target.id);
  return withSubjectLocks(db, [binding.id], async () => {
    if (await fencedUntil(input.orgId, target.id, p)) throw new Invalid('contact_fenced', 'Target is fenced');
    const current = (await bindingsForContact(input.orgId, target.id)).find((r) => r.id === binding.id);
    if (!current || current.entraOid !== binding.entraOid || current.entraTenantId !== binding.entraTenantId) throw new Invalid('target_rebound', 'Target binding changed');
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(v)
      .where(and(eq(v.orgId, input.orgId), eq(v.contactId, target.id), sql`${v.createdAt}>now()-interval '1 hour'`));
    if (count! >= p.maxAttemptsPerHour) throw new Invalid('attempt_cap', 'Contact attempt limit reached');
    const proof = await ports.consumeStepUp(actor, {
      orgId: input.orgId, target: { entraTenantId: binding.entraTenantId!, entraOid: binding.entraOid! },
      reason: input.reason.trim(), stepUpGrantId: input.stepUpGrantId,
    });
    const now = new Date();
    const [row] = await db.insert(v).values({
      orgId: input.orgId, contactId: target.id, requesterBindingId: null, targetBindingId: binding.id,
      targetEntraTenantId: binding.entraTenantId, targetEntraOid: binding.entraOid,
      initiatedByUserId: actor.userId, technicianLabel: actor.displayName, actionScope: 'disable_user',
      targetLabel: binding.upnSnapshot ?? target.name, method: 'administrative_stepup', reason: input.reason.trim(),
      stepupSessionId: proof.sid, stepupAuthEpoch: proof.authEpoch, stepupMfaEpoch: proof.mfaEpoch, stepupVerifiedAt: now,
      status: 'verified', tier: 3, tierReason: 'administrative', ...challengeSecrets(),
      attemptNo: count! + 1, decidedAt: now, expiresAt: new Date(now.getTime() + p.verificationTtlMinutes * 60000),
    }).returning();
    await recordEffect(row!, 'administrative_created', actor.userId);
    return projectVerification(row!, actor.userId, target.id);
  });
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/**
 * Pure transition table. `not_me` is accepted from any non-rejected state;
 * everything else requires a live pending challenge. Timeout never approves.
 */
export function decisionStatus(status: CallerVerificationStatus, expiresAt: Date, decision: Decision, match: string): CallerVerificationStatus | null {
  if (decision.kind === 'not_me') return status === 'rejected_by_user' ? null : 'rejected_by_user';
  if (status !== 'pending') return null;
  if (decision.kind === 'timeout' || expiresAt.getTime() <= Date.now()) return 'expired';
  if (decision.kind === 'undeliverable') return 'undeliverable';
  return decision.value === match ? 'verified' : 'wrong_choice';
}

export async function cancel(actor: CallerVerificationActor, orgId: string, id: string): Promise<VerificationDetails> {
  await get(actor, orgId, id);
  const [row] = await db.update(v).set({ status: 'cancelled', decidedAt: new Date() })
    .where(and(eq(v.orgId, orgId), eq(v.id, id), eq(v.status, 'pending'))).returning();
  if (row) await recordEffect(row, 'cancelled', actor.userId);
  return get(actor, orgId, id);
}

/** Callback attestation: the technician called the established number back. */
export async function attest(actor: CallerVerificationActor, orgId: string, id: string, note: string): Promise<VerificationDetails> {
  if (note.trim().length < 20) throw new Invalid('invalid_note', 'Callback note must contain at least 20 characters');
  await get(actor, orgId, id);
  const row = await loadVerification(orgId, id);
  if (row.method !== 'callback_attestation') throw new Invalid('invalid_method', 'Only callback attempts can be attested');
  await withSubjectLocks(db, [row.requesterBindingId, row.targetBindingId], async () => {
    const p = await getEffectivePolicy(orgId);
    if (await fencedUntil(orgId, row.contactId, p)) throw new Invalid('contact_fenced', 'Contact is fenced');
    const [changed] = await db.update(v)
      .set({ status: 'verified', decidedAt: new Date(), attestationNote: note.trim(), tier: 1, tierReason: 'attestation' })
      .where(and(eq(v.id, id), eq(v.orgId, orgId), eq(v.status, 'pending'))).returning();
    if (changed) await recordEffect(changed, 'verified', actor.userId);
  });
  return get(actor, orgId, id);
}

/**
 * Apply a caller's decision (W02 workstation result, W03 link, publisher
 * timeout). Reuses any existing authorized transaction and opens a system one
 * only when no context exists — W03 must keep this any-context rule. The
 * identity namespace lock precedes subject locks so W02 can call
 * `observeLogin` afterwards in the same transaction. Callers authenticate
 * command/token ownership BEFORE calling this.
 */
export async function applyDecision(input: {
  verificationId: string;
  decision: Decision;
  principal?: { osPrincipal: string; osUsername: string; upn: string | null };
  fromIp?: string;
}): Promise<VerificationView> {
  const decide = async (): Promise<VerificationView> => {
    const [row] = await db.select().from(v).where(eq(v.id, input.verificationId)).limit(1);
    if (!row) throw new Invalid('not_found', 'Verification not found');
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${row.orgId}`}))`);
    if (input.decision.kind === 'not_me') {
      await handleRejection(row.id);
      return view(await loadVerification(row.orgId, row.id), null, await targetContact(row));
    }
    const decision = input.decision;
    return withSubjectLocks(db, [row.requesterBindingId, row.targetBindingId], async () => {
      const fresh = await loadVerification(row.orgId, row.id);
      const status = decisionStatus(fresh.status, fresh.expiresAt, decision, fresh.matchValue);
      if (!status) return view(fresh, null, await targetContact(fresh));
      const p = await getEffectivePolicy(row.orgId);
      const bindings = await bindingsForContact(row.orgId, row.contactId);
      const principal = input.principal;
      const bound = !!principal && !!principal.upn
        && bindings.some((x) => x.osPrincipal === principal.osPrincipal && x.upnSnapshot?.toLowerCase() === principal.upn!.toLowerCase());
      const dest = row.method === 'sms' || row.method === 'email' ? await currentDestination(row.orgId, row.contactId, row.method === 'sms' ? 'mobile' : 'email') : null;
      const tier = computeTier({ method: row.method, boundPrincipal: bound, destinationEstablished: !!dest && dest.id === row.destinationId && isEstablished(dest, p), policy: p });
      const [changed] = await db.update(v).set({
        status, decidedAt: new Date(), decidedFromIp: input.fromIp ?? null, osPrincipalObserved: principal?.osPrincipal ?? null,
        tier: tier.tier, tierReason: tier.reason,
        ...(decision.kind === 'undeliverable' ? { reason: decision.reason } : {}),
      }).where(and(
        eq(v.id, row.id), eq(v.status, 'pending'),
        ...(status === 'verified' || status === 'wrong_choice' ? [sql`${v.expiresAt}>now()`] : []),
      )).returning();
      if (changed) await recordEffect(changed, status);
      return view(changed ?? await loadVerification(row.orgId, row.id), null, await targetContact(row));
    });
  };
  if (getCurrentDbAccessContext()) return decide();
  return withSystemDbAccessContext(decide, 'callerVerification.applyDecision');
}
