import { sql } from 'drizzle-orm';
import { db } from '../db';
import { requestPamCleanup, type PamActuationRef } from './pamActuationLifecycle';

type PamEntitlementTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type PamEntitlementSource = {
  kind: 'license' | 'subscription' | 'policy';
  id: string;
};

type RequestIdRow = Record<string, unknown> & { elevation_request_id: string };

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

/**
 * The sole shipping boundary for entitlement-triggered PAM cleanup. Callers
 * must invoke it inside the same winning transaction that removes the
 * entitlement; the locked request list and every generation/outbox mutation
 * therefore commit or roll back together.
 */
export async function removePamEntitlement(tx: PamEntitlementTx, input: {
  orgId: string;
  deviceId: string;
  subjectId: string;
  source: PamEntitlementSource;
}): Promise<readonly PamActuationRef[]> {
  const matching = rows<RequestIdRow>(await tx.execute<RequestIdRow>(sql`
    SELECT DISTINCT r.id AS elevation_request_id
    FROM elevation_requests r
    JOIN pam_actuations a ON a.elevation_request_id = r.id
    WHERE r.org_id = ${input.orgId}
      AND r.device_id = ${input.deviceId}
      AND r.subject_user_id = ${input.subjectId}
      AND r.status IN ('approved', 'auto_approved', 'actuating')
      AND a.desired_state = 'active'
    ORDER BY r.id
    FOR UPDATE OF r
  `));

  // The source is intentionally part of this boundary even though the frozen
  // lifecycle API records the normalized cause. Callers retain the concrete
  // SKU/subscription/policy id in their own audit event in the same tx.
  void input.source;

  const refs: PamActuationRef[] = [];
  for (const row of matching) {
    refs.push(await requestPamCleanup(tx, {
      elevationRequestId: row.elevation_request_id,
      cause: 'entitlement_removed',
    }));
  }
  return Object.freeze(refs);
}
