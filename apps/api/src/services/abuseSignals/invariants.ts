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

  return signals;
}
