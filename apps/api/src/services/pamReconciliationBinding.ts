import { sql } from 'drizzle-orm';

import { db } from '../db';

export type PamReconciliationCandidate = {
  observationId: string;
  actuationId: string;
  generation: number;
};

export type PamReconciliationProtocolVersion = 1 | 2;

/** The v1 wire dispositions. v1 never carries `retired`. */
export type PamReconciliationBindingDispositionV1 =
  | { status: 'bound'; observationId: string; commandId: string }
  | { status: 'duplicate'; observationId: string }
  | { status: 'stale'; observationId: string }
  | { status: 'unresolved'; observationId: string };

/**
 * `retired` (protocol v2, PAM ownership epochs #8202): the candidate belongs
 * to an EARLIER ownership epoch of this device and is closed or carries a
 * retirement marker, so the agent may remove its ledger entry durably.
 */
export type PamReconciliationBindingDisposition =
  | PamReconciliationBindingDispositionV1
  | { status: 'retired'; observationId: string };

type ResolverRow = {
  ordinal: number | string;
  observation_id: string;
  status: string;
  command_id: string | null;
};

const RESOLVER_STATUSES: ReadonlySet<string> = new Set(['bound', 'duplicate', 'stale', 'unresolved', 'retired']);

function rows<T>(result: unknown): T[] {
  const value = (result as { rows?: T[] }).rows ?? result;
  return Array.isArray(value) ? value : [];
}

function unresolved(candidates: readonly PamReconciliationCandidate[]): PamReconciliationBindingDisposition[] {
  return candidates.map((candidate) => ({
    status: 'unresolved',
    observationId: candidate.observationId,
  }));
}

/**
 * Protocol v1 maps `retired` to `stale`: the agent disposes the observation,
 * records nothing and reopens admission. This widened meaning of v1 `stale`
 * is recorded in the reconciliation-binding spec's 2026-10 amendment.
 */
export function toV1Disposition(
  disposition: PamReconciliationBindingDisposition,
): PamReconciliationBindingDispositionV1 {
  if (disposition.status === 'retired') {
    return { status: 'stale', observationId: disposition.observationId };
  }
  return disposition;
}

/**
 * Resolves agent reconciliation candidates through the definer function
 * `breeze_pam_epoch_binding` (migration 2026-12-24-130000). Ownership of an
 * actuation is proven by the device's epoch lineage, not by the live org. The
 * caller's ambient DB context must have access to the device's live org;
 * otherwise every candidate is `unresolved`.
 */
export async function resolvePamReconciliationBindings(input: {
  agentId: string;
  deviceId: string;
  protocolVersion: PamReconciliationProtocolVersion;
  candidates: readonly PamReconciliationCandidate[];
}): Promise<PamReconciliationBindingDisposition[]> {
  if (input.candidates.length === 0) return [];

  const encodedCandidates = JSON.stringify(input.candidates.map((candidate, index) => ({
    ordinal: index + 1,
    observation_id: candidate.observationId,
    actuation_id: candidate.actuationId,
    generation: candidate.generation,
  })));

  const result = await db.execute<ResolverRow>(sql`
    SELECT ordinal,
           observation_id::text AS observation_id,
           status,
           command_id::text AS command_id
    FROM public.breeze_pam_epoch_binding(
      ${input.agentId}::text,
      ${input.deviceId}::uuid,
      ${encodedCandidates}::jsonb
    )
    ORDER BY ordinal
  `);

  const resultRows = rows<ResolverRow>(result);
  if (resultRows.length !== input.candidates.length) return unresolved(input.candidates);

  const dispositions: PamReconciliationBindingDisposition[] = [];
  const seenOrdinals = new Set<number>();
  for (const row of resultRows) {
    const ordinal = Number(row.ordinal);
    const candidate = input.candidates[ordinal - 1];
    if (
      !Number.isInteger(ordinal)
      || ordinal < 1
      || seenOrdinals.has(ordinal)
      || !candidate
      || row.observation_id !== candidate.observationId
      || !RESOLVER_STATUSES.has(row.status)
      || (row.status === 'bound' && !row.command_id)
      || (row.status !== 'bound' && row.command_id !== null)
    ) {
      return unresolved(input.candidates);
    }
    seenOrdinals.add(ordinal);
    if (row.status === 'bound') {
      dispositions.push({
        status: 'bound',
        observationId: row.observation_id,
        commandId: row.command_id!,
      });
    } else {
      dispositions.push({
        status: row.status,
        observationId: row.observation_id,
      } as PamReconciliationBindingDisposition);
    }
  }

  dispositions.sort((left, right) => {
    const leftIndex = input.candidates.findIndex((candidate) => candidate.observationId === left.observationId);
    const rightIndex = input.candidates.findIndex((candidate) => candidate.observationId === right.observationId);
    return leftIndex - rightIndex;
  });
  return input.protocolVersion === 1 ? dispositions.map(toV1Disposition) : dispositions;
}
