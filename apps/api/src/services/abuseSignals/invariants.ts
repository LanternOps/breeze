import { sql } from 'drizzle-orm';
import { db } from '../../db';
import type { ComputedSignal } from './types';

// Activation invariants — conditions the signup gate makes impossible, so any
// hit means gate drift (deploy lag, manual SQL, a new bypass). Suppression of
// reviewed/grandfathered accounts happens via acknowledged_at in persistence,
// NEVER via allowlists here (public repo: no tenant identifiers in code).
// MUST run inside a system DB context — bare breeze_app reads return 0 rows.
export async function computeInvariantSignals(): Promise<ComputedSignal[]> {
  const signals: ComputedSignal[] = [];

  const unverified = (await db.execute(sql`
    SELECT id, name, created_at FROM partners
    WHERE status = 'active' AND email_verified_at IS NULL AND deleted_at IS NULL
  `)) as unknown as Array<{ id: string; name: string; created_at: string }>;
  for (const p of unverified) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.active_unverified_email',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerCreatedAt: p.created_at },
    });
  }

  const unpaid = (await db.execute(sql`
    SELECT id, name, created_at FROM partners
    WHERE status = 'active' AND payment_method_attached_at IS NULL AND deleted_at IS NULL
  `)) as unknown as Array<{ id: string; name: string; created_at: string }>;
  for (const p of unpaid) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.active_no_payment',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerCreatedAt: p.created_at },
    });
  }

  const inactiveWithAgents = (await db.execute(sql`
    SELECT p.id, p.name, p.status, COUNT(d.id) AS device_count
    FROM partners p
    JOIN organizations o ON o.partner_id = p.id
    JOIN devices d ON d.org_id = o.id
    WHERE p.status IN ('pending', 'suspended')
      AND d.status NOT IN ('decommissioned', 'quarantined')
      -- Intentionally omit deleted_at IS NULL: a soft-deleted partner with live devices is itself the anomaly
    GROUP BY p.id, p.name, p.status
  `)) as unknown as Array<{ id: string; name: string; status: string; device_count: string }>;
  for (const p of inactiveWithAgents) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.inactive_partner_with_agents',
      score: 100,
      severity: 'alert',
      evidence: { partnerName: p.name, partnerStatus: p.status, deviceCount: Number(p.device_count) },
    });
  }

  // A partner we took out of 'active' is still being billed. Lives here rather
  // than in heuristics.ts for two structural reasons: the heuristics `scoped`
  // CTE filters p.status = 'active', so it can never see a suspended partner,
  // and its push() age-decays — a suspended account's live subscription is a
  // breach at any account age. Pure SQL against the snapshot the billing
  // service writes; the sweep NEVER calls the payment provider.
  //
  // Detection only. Cancelling the subscription is a money-affecting external
  // write (refund-vs-leave is a business decision) and is deliberately out of
  // scope for the sweep.
  const suspendedButSubscribed = (await db.execute(sql`
    SELECT id, name, status, billing_subscription_status FROM partners
    WHERE status <> 'active'
      AND billing_subscription_status IN ('active', 'past_due')
      -- Intentionally omit deleted_at IS NULL: a soft-deleted partner still
      -- carrying a live subscription is itself the anomaly.
  `)) as unknown as Array<{
    id: string;
    name: string;
    status: string;
    billing_subscription_status: string;
  }>;
  for (const p of suspendedButSubscribed) {
    signals.push({
      partnerId: p.id,
      signalKey: 'invariant.suspended_partner_active_subscription',
      score: 100,
      severity: 'alert',
      evidence: {
        partnerName: p.name,
        partnerStatus: p.status,
        subscriptionStatus: p.billing_subscription_status,
      },
    });
  }

  return signals;
}
