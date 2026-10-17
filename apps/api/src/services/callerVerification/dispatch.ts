/**
 * Caller verification W05 (#6354): the LAST check before a protected Microsoft
 * 365 identity mutation leaves Breeze, and the committed dispatch marker.
 *
 * Every backend (direct Graph, the Graph actions executor, the Delegant broker)
 * calls `prepareCallerDispatch` immediately before its outbound request, with
 * the connection id and tenant it is ABOUT to use and the object id it is
 * about to mutate. It:
 *
 *   1. refuses outright without a durable intent (no intent = no dispatch);
 *   2. reads the intent's immutable pin and the grant the release path already
 *      consumed for it (short system transaction, no locks);
 *   3. prefetches the target's mailbox set for an email grant (Graph I/O with
 *      no DB context and no locks held);
 *   4. opens ONE fresh system transaction, takes the requester + target subject
 *      locks (the same locks a "This is not me" rejection takes), re-runs the
 *      real gate in `check` mode against ONLY the consumed grant inside that
 *      transaction, and CASes `dispatch_started_at` — then COMMITS before
 *      returning, so the marker is visible before any HTTP leaves.
 *
 * A rejection that commits first leaves a fence this transaction sees (refuse,
 * no marker, no mutation). A rejection that waits on the locks sees the
 * committed marker and reports the intent as "already dispatched" — honest,
 * not a claim that Microsoft applied it.
 *
 * Tier zero (an explicit policy bypass) skips binding/grant/fence checks but
 * keeps the feature flag, the pin, tenant match and the marker.
 *
 * The transaction runs under system scope with explicit org predicates, like
 * the gate itself: inputs come only from the pinned intent row and the
 * backend's own connection, never from a request body or tool argument.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { actionIntents } from '../../db/schema/actionIntents';
import { callerVerifications } from '../../db/schema/callerVerification';
import { captureException } from '../sentry';
import { callerAction, loadPinnedCallerBackend } from '../actionIntents/callerTarget';
import type { CallerVerificationAction } from './types';
import { CallerVerificationRequiredError, CallerVerificationValidationError, type CallerVerificationRefusal } from './errors';
import { getEffectivePolicy } from './policy';
import { resolveTargetBinding } from './subjects';
import { withSubjectLocks } from './locks';
import { isCallerVerificationEnabled, requireCallerVerification, type GateInput } from './gate';
import { withPreparedDispatchGate } from './dispatchGateContext';
import { callerVerificationPorts } from './ports';
import { withMailboxReader } from './mailboxReader';
import { destinationHash, normalizeDestination } from './destinations';

export interface PrepareCallerDispatchInput {
  orgId: string;
  /** The approved action intent being released. Absent → refused. */
  intentId?: string;
  action: CallerVerificationAction;
  /** The connection row the backend is about to send through. */
  connectionId: string;
  /** That connection's tenant, as the backend observed it. */
  backendTenantId: string;
  /** The object id the backend is about to mutate. */
  oid: string;
}

/** Thrown when an intent's marker is already set: never blindly re-send. */
export class CallerDispatchAlreadyStartedError extends Error {
  constructor(public readonly intentId: string) {
    super('Dispatch already started; reconcile the existing intent before retrying');
    this.name = 'CallerDispatchAlreadyStartedError';
  }
}

function requiredTierFor(policy: Awaited<ReturnType<typeof getEffectivePolicy>>, action: CallerVerificationAction): number {
  return action === 'reset_password' ? policy.requiredTierResetPassword : policy.requiredTierDisableUser;
}

const lower = (value: string | null | undefined) => (typeof value === 'string' ? value.toLowerCase() : null);

export async function prepareCallerDispatch(
  input: PrepareCallerDispatchInput,
  gate: typeof requireCallerVerification = requireCallerVerification,
): Promise<void> {
  let requiredTier = 2;
  const refuse = (reason: CallerVerificationRefusal): never => {
    throw new CallerVerificationRequiredError({
      orgId: input.orgId, contactId: null, action: input.action, requiredTier, reason, latest: null,
    });
  };
  if (!input.intentId) refuse('no_fresh_verification');
  const intentId = input.intentId!;
  if (!isCallerVerificationEnabled()) refuse('feature_disabled');

  type Pin = typeof actionIntents.$inferSelect;
  // Validates the pinned intent against what the backend is about to do.
  // Re-run under the marker transaction: a pre-lock read is never authority.
  const assertPin = (intent: Pin | undefined): Pin => {
    if (!intent || intent.orgId !== input.orgId || intent.status !== 'executing') return refuse('no_fresh_verification');
    if (!intent.requestedByUserId || intent.requestingAgentRunId) return refuse('technician_mismatch');
    if (callerAction(intent.actionName) !== input.action) return refuse('target_rebound');
    if (!intent.targetEntraTenantId || !intent.targetEntraOid || !intent.targetConnectionRef) return refuse('subject_unmatched');
    if (intent.targetConnectionRef !== input.connectionId || lower(intent.targetEntraOid) !== lower(input.oid)) {
      return refuse('target_rebound');
    }
    if (lower(intent.targetEntraTenantId) !== lower(input.backendTenantId)) return refuse('tenant_mismatch');
    return intent;
  };
  const loadIntent = async () => (await db.select().from(actionIntents).where(and(
    eq(actionIntents.id, intentId), eq(actionIntents.orgId, input.orgId),
  )).limit(1))[0];

  // Phase 1: pin + consumed grant, no locks.
  const prepared = await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const pin = assertPin(await loadIntent());
    requiredTier = requiredTierFor(await getEffectivePolicy(input.orgId), input.action);
    const [grant] = requiredTier === 0 ? [] : await db.select().from(callerVerifications).where(and(
      eq(callerVerifications.orgId, input.orgId), eq(callerVerifications.consumedIntentRef, pin.id),
    )).limit(1);
    return { pin, grant: grant ?? null };
  }, 'callerVerification.dispatch.prepare'));
  const gateInput: GateInput = {
    orgId: input.orgId, action: input.action,
    target: { entraTenantId: prepared.pin.targetEntraTenantId!, entraOid: prepared.pin.targetEntraOid! },
    backendTenantId: input.backendTenantId, technicianUserId: prepared.pin.requestedByUserId!,
    intentId, mode: 'check',
  };

  // Phase 2: mailbox prefetch for an email grant — outside every DB context
  // and before any lock. A failure leaves null, which the gate refuses as
  // `subject_mailboxes_unknown` (fail closed, never silently).
  let mailboxHashes: Set<string> | null = null;
  if (prepared.grant?.method === 'email') {
    try {
      const addresses = await runOutsideDbContext(() => withMailboxReader(gateInput.technicianUserId,
        () => callerVerificationPorts.mailboxes({ orgId: input.orgId, target: gateInput.target })));
      mailboxHashes = new Set(addresses.map((a) => a.replace(/^smtp:/i, ''))
        .map((a) => normalizeDestination('email', a))
        .filter((a): a is string => !!a)
        .map(destinationHash));
    } catch (err) {
      console.error('[callerVerification] dispatch mailbox read failed; email grant will be refused', {
        orgId: input.orgId, intentId, error: err instanceof Error ? err.message : String(err),
      });
      captureException(err instanceof Error ? err : new Error(String(err)));
      mailboxHashes = null;
    }
  }

  // Phase 3: the committed marker transaction.
  await runOutsideDbContext(() => withSystemDbAccessContext(async () => {
    const intent = assertPin(await loadIntent());
    if (intent.dispatchStartedAt) throw new CallerDispatchAlreadyStartedError(intent.id);
    let backend;
    try {
      backend = await loadPinnedCallerBackend(input.orgId, input.connectionId);
    } catch (error) {
      if (error instanceof CallerVerificationValidationError) refuse('tenant_mismatch');
      throw error;
    }
    if (lower(backend!.tenantId) !== lower(input.backendTenantId) || lower(backend!.tenantId) !== lower(intent.targetEntraTenantId)) {
      refuse('tenant_mismatch');
    }
    if (!isCallerVerificationEnabled()) refuse('feature_disabled');
    requiredTier = requiredTierFor(await getEffectivePolicy(input.orgId), input.action);

    const markDispatch = async () => {
      const marked = await db.update(actionIntents).set({ dispatchStartedAt: sql`now()` }).where(and(
        eq(actionIntents.id, intent.id), eq(actionIntents.orgId, input.orgId),
        eq(actionIntents.status, 'executing'), isNull(actionIntents.dispatchStartedAt),
      )).returning({ id: actionIntents.id });
      if (!marked.length) throw new CallerDispatchAlreadyStartedError(intent.id);
    };
    // Policy can waive verification-specific checks; never the durable boundary.
    if (requiredTier === 0) { await markDispatch(); return; }

    const target = await resolveTargetBinding(input.orgId, gateInput.target);
    const consumed = prepared.grant;
    if (!consumed?.consumedAt || consumed.consumedIntentRef !== intent.id) refuse('grant_consumed');
    if (consumed!.targetBindingId !== target.id) refuse('target_rebound');

    await withSubjectLocks(db, [target.id, consumed!.requesterBindingId], async () => {
      // Authority is re-read under the locks; the pre-lock snapshot is not.
      const [locked] = await db.select().from(callerVerifications).where(and(
        eq(callerVerifications.id, consumed!.id), eq(callerVerifications.orgId, input.orgId),
        eq(callerVerifications.consumedIntentRef, intent.id),
      )).limit(1);
      if (!locked?.consumedAt || locked.requesterBindingId !== consumed!.requesterBindingId || locked.targetBindingId !== target.id) {
        refuse('target_rebound');
      }
      // The real gate, in THIS transaction, against ONLY the consumed grant:
      // flag, policy tier, binding, destination, requester authority,
      // administrative session/epochs, workstation flag, and both fences.
      const verified = await withPreparedDispatchGate(
        { input: gateInput, verificationId: consumed!.id, mailboxHashes },
        () => gate(gateInput),
      );
      if (verified.verificationId !== consumed!.id) refuse('grant_consumed');
      await markDispatch();
    });
  }, 'callerVerification.dispatch.marker'));
}
