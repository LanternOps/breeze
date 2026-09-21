/**
 * Release gate for identity-changing actions (spec D4, D13, D16, D18).
 *
 * `requireCallerVerification` is called by W05's backend dispatch with
 * server-resolved inputs (never from a public route). Refusal order is fixed:
 *   flag → tier-zero bypass → backend tenant match → canonical target
 *   → fence → per-candidate checks under locks → consume CAS.
 *
 * Nothing stored on the row is trusted for assurance: tier is recomputed from
 * the CURRENT policy, binding, roles, destination and mailbox state under the
 * consume locks. A refusal never consumes. A same-intent retry returns the
 * grant already consumed by that intent. Tier zero returns
 * `{verificationId:'', tier:0}` — an explicit bypass, not a consumed grant.
 *
 * The gate runs in its own short system transactions (the boundary is
 * internal), with mailbox I/O between them. A caller inside a request
 * transaction must invoke it after that transaction closes.
 */
import { and, eq, desc, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { callerVerifications as v, callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { contacts } from '../../db/schema/contacts';
import { devices } from '../../db/schema/devices';
import { callerVerificationEnabled } from '../../config/env';
import type { CallerVerificationAction, EntraSubject, VerificationRow } from './types';
import { CallerVerificationRequiredError, type CallerVerificationRefusal } from './errors';
import { getEffectivePolicy, type EffectiveCallerVerificationPolicy } from './policy';
import { resolveTargetBinding } from './subjects';
import { currentDestination, isEstablished, destinationHash, normalizeDestination } from './destinations';
import { requesterAuthorized } from './access';
import { computeTier } from './tiers';
import { withSubjectLocks } from './locks';
import { callerVerificationPorts as ports } from './ports';

export interface GateInput {
  orgId: string;
  action: CallerVerificationAction;
  target: EntraSubject;
  backendTenantId: string;
  technicianUserId: string;
  intentId: string;
  mode: 'check' | 'consume';
}

export function isCallerVerificationEnabled(): boolean {
  return callerVerificationEnabled();
}

/**
 * The subject fence: a "This is not me" rejection blocks every new grant for
 * `coolingOffHours` after the decision unless a security reviewer overrode
 * it (`fence_override_until` in the future covers the fence window).
 */
export async function fencedUntil(orgId: string, contactId: string, policy: EffectiveCallerVerificationPolicy): Promise<Date | null> {
  const rows = await db.select().from(v).where(and(eq(v.orgId, orgId), eq(v.contactId, contactId), eq(v.status, 'rejected_by_user')));
  const now = Date.now();
  const times = rows
    .filter((r) => r.decidedAt && (!r.fenceOverrideUntil || r.fenceOverrideUntil.getTime() <= now))
    .map((r) => r.decidedAt!.getTime() + policy.coolingOffHours * 3600000)
    .filter((n) => n > now);
  return times.length ? new Date(Math.max(...times)) : null;
}

function requiredTierFor(p: EffectiveCallerVerificationPolicy, action: CallerVerificationAction): number {
  return action === 'reset_password' ? p.requiredTierResetPassword : p.requiredTierDisableUser;
}

export async function requireCallerVerification(input: GateInput): Promise<{ verificationId: string; tier: number }> {
  let latest: VerificationRow | null = null;
  let requiredTier = 2;
  let contactId: string | null = null;
  const refuse = (reason: CallerVerificationRefusal): never => {
    throw new CallerVerificationRequiredError({
      orgId: input.orgId, contactId, action: input.action, requiredTier, reason,
      latest: latest ? { id: latest.id, status: latest.status, method: latest.method, decidedAt: latest.decidedAt?.toISOString() ?? null } : null,
    });
  };
  if (!isCallerVerificationEnabled()) refuse('feature_disabled');

  return runOutsideDbContext(async () => {
    const initial = await withSystemDbAccessContext(async () => {
      const p = await getEffectivePolicy(input.orgId);
      requiredTier = requiredTierFor(p, input.action);
      if (requiredTier === 0) return { p, target: null, rows: [] as VerificationRow[] };
      if (input.backendTenantId !== input.target.entraTenantId) refuse('tenant_mismatch');
      let target;
      try {
        target = await resolveTargetBinding(input.orgId, input.target);
      } catch (e) {
        if (e instanceof CallerVerificationRequiredError) {
          // A subject that WAS bound and is now unmatched/ambiguous was rebound.
          const [historical] = await db.select().from(v)
            .where(and(eq(v.orgId, input.orgId), eq(v.targetEntraTenantId, input.target.entraTenantId), eq(v.targetEntraOid, input.target.entraOid)))
            .orderBy(desc(v.createdAt)).limit(1);
          latest = historical ?? null;
          if (historical) refuse('target_rebound');
          refuse(e.payload.reason);
        }
        throw e;
      }
      contactId = target.contactId;
      const rows = await db.select().from(v)
        .where(and(eq(v.orgId, input.orgId), eq(v.targetBindingId, target.id)))
        .orderBy(desc(v.createdAt));
      latest = rows[0] ?? null;
      await withSubjectLocks(db, [target.id, ...rows.filter((r) => r.status === 'verified').map((r) => r.requesterBindingId)], async () => {
        if (await fencedUntil(input.orgId, target.contactId, p)) refuse('contact_fenced');
        for (const row of rows.filter((r) => r.status === 'verified')) {
          if (await fencedUntil(input.orgId, row.contactId, p)) refuse('contact_fenced');
        }
      });
      return { p, target, rows };
    }, 'callerVerification.gate.prepare');
    if (!initial.target) return { verificationId: '', tier: 0 };

    // Mailbox read only when an email candidate exists; a failure is
    // remembered for email candidates and never applied to other methods.
    let mailboxHashes: Set<string> | null = null;
    if (initial.rows.some((r) => r.status === 'verified' && r.method === 'email')) {
      try {
        mailboxHashes = new Set(
          (await ports.mailboxes({ orgId: input.orgId, target: input.target }))
            .map((a) => a.replace(/^smtp:/i, ''))
            .map((a) => normalizeDestination('email', a))
            .filter((a): a is string => !!a)
            .map(destinationHash),
        );
      } catch {
        mailboxHashes = null;
      }
    }

    let reason: CallerVerificationRefusal = 'no_fresh_verification';
    for (const candidate of initial.rows) {
      const result = await withSystemDbAccessContext(() => withSubjectLocks(db, [candidate.requesterBindingId, initial.target!.id], async () => {
        // Everything below is re-read under the consume locks.
        const p = await getEffectivePolicy(input.orgId);
        requiredTier = requiredTierFor(p, input.action);
        if (requiredTier === 0) return { verificationId: '', tier: 0 };
        const target = await resolveTargetBinding(input.orgId, input.target);
        if (await fencedUntil(input.orgId, target.contactId, p)) refuse('contact_fenced');
        const [r] = await db.select().from(v).where(and(eq(v.orgId, input.orgId), eq(v.id, candidate.id))).limit(1);
        if (!r) return null;
        latest = r;
        if (await fencedUntil(input.orgId, r.contactId, p)) refuse('contact_fenced');
        if (r.status !== 'verified') { if (r.status === 'revoked') reason = 'target_rebound'; return null; }
        if (r.targetBindingId !== target.id || r.targetEntraTenantId !== input.target.entraTenantId || r.targetEntraOid !== input.target.entraOid) {
          reason = 'target_rebound'; return null;
        }
        if (r.consumedAt && r.consumedIntentRef !== input.intentId) { reason = 'grant_consumed'; return null; }
        if (r.actionScope !== input.action && r.actionScope !== 'any') return null;
        if (!p.allowCrossTechnicianUse && r.initiatedByUserId !== input.technicianUserId) { reason = 'technician_mismatch'; return null; }
        let bound = false;
        let destinationEstablished = false;
        if (r.method === 'administrative_stepup') {
          if (input.action !== 'disable_user' || r.actionScope !== 'disable_user') return null;
          if (!p.allowAdministrativeDisable) { reason = 'administrative_disabled'; return null; }
          if (!r.stepupVerifiedAt || r.stepupVerifiedAt.getTime() <= Date.now() - p.verificationTtlMinutes * 60000 || !(await ports.administrativeEligible(r))) {
            reason = 'stepup_invalidated'; return null;
          }
        } else {
          if (!r.decidedAt || r.decidedAt.getTime() <= Date.now() - p.verificationTtlMinutes * 60000) return null;
          const [requester] = r.requesterBindingId
            ? await db.select().from(b).where(and(eq(b.id, r.requesterBindingId), eq(b.orgId, input.orgId), isNull(b.revokedAt))).limit(1)
            : [];
          if (!requester) { reason = 'subject_unmatched'; return null; }
          const [contact] = await db.select().from(contacts).where(and(eq(contacts.id, r.contactId), eq(contacts.orgId, input.orgId))).limit(1);
          if (!contact || !requesterAuthorized(input.action, requester, target, contact, p.disableUserAuthorizerRoles)) {
            reason = 'requester_not_authorized'; return null;
          }
          bound = !!r.osPrincipalObserved && requester.osPrincipal === r.osPrincipalObserved;
          if (r.method === 'workstation') {
            // The device must still belong to this org (a moved device is a rebound target).
            const [device] = r.workstationDeviceRef
              ? await db.select({ id: devices.id }).from(devices).where(and(eq(devices.id, r.workstationDeviceRef), eq(devices.orgId, input.orgId))).limit(1)
              : [];
            if (!device) { reason = 'target_rebound'; return null; }
          }
          if (r.method === 'sms' || r.method === 'email') {
            const d = await currentDestination(input.orgId, r.contactId, r.method === 'sms' ? 'mobile' : 'email');
            if (!d || d.id !== r.destinationId) return null;
            destinationEstablished = isEstablished(d, p);
            if (r.method === 'email') {
              if (mailboxHashes === null) { reason = 'subject_mailboxes_unknown'; return null; }
              // A link delivered to the target's own mailbox proves nothing.
              if (mailboxHashes.has(d.valueHash)) return null;
            }
          }
        }
        const tier = computeTier({ method: r.method, boundPrincipal: bound, destinationEstablished, policy: p }).tier;
        if (tier < requiredTier) return null;
        if (input.mode === 'consume' && !r.consumedAt) {
          const changed = await db.update(v)
            .set({ consumedAt: new Date(), consumedIntentRef: input.intentId })
            .where(and(eq(v.id, r.id), eq(v.orgId, input.orgId), eq(v.status, 'verified'), isNull(v.consumedAt)))
            .returning({ id: v.id });
          if (!changed.length) { reason = 'grant_consumed'; return null; }
        }
        return { verificationId: r.id, tier };
      }), 'callerVerification.gate.consume');
      if (result) return result;
    }
    // No grant must not suppress an existing target fence.
    await withSystemDbAccessContext(() => withSubjectLocks(db, [initial.target!.id], async () => {
      if (await fencedUntil(input.orgId, initial.target!.contactId, initial.p)) refuse('contact_fenced');
    }), 'callerVerification.gate.empty');
    return refuse(reason);
  });
}
