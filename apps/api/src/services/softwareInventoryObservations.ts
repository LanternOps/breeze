import { createHash, randomUUID } from 'node:crypto';
import type {
  LegacySoftwareInventoryReport,
  SoftwareInventoryItem,
  SoftwareInventoryObservationV2,
} from '@breeze/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { deviceVulnerabilities, softwareInventory } from '../db/schema';
import { tightenLockTimeout } from '../db/lockTimeout';
import { resolveInventoryVersion } from '../routes/agents/agentSelfInventory';
import { sanitizeDate } from '../routes/agents/helpers';
import { retryOnTransientLockError } from '../utils/pgErrors';

/**
 * Bound for `lock_timeout`, set at the top of the ingest transaction (#3925).
 *
 * `correlateOrg`'s per-org pass (vulnerabilityCorrelation.ts) can legitimately
 * hold `device_vulnerabilities` / `software_inventory` row locks for its whole
 * duration — see the lock-ordering comment there. Before this, an ingest that
 * overlapped a pass WAITED on those locks with nothing bounding the wait
 * (`idle_in_transaction_session_timeout` doesn't apply — a backend blocked on
 * a lock isn't idle). If the wait outlived the agent's 30s HTTP budget
 * (`sendInventoryData` in agent/internal/heartbeat/heartbeat.go), the report
 * was dropped SILENTLY: no SQLSTATE, so no Sentry event and no retry log.
 *
 * 5s leaves room for `retryOnTransientLockError`'s 3 attempts (worst case
 * 3 x 5s = 15s of waiting) plus the transaction's own work inside that 30s
 * budget. A timed-out acquisition now raises 55P03 (`lock_not_available`),
 * which `isTransientLockError` classifies as transient, so the wait becomes
 * bounded and, when exceeded, LOUD instead of silent.
 *
 * Not restored on success: this transaction is the entire scope of one
 * ingest attempt — `runOutsideDbContext`/`withSystemDbAccessContext` open a
 * fresh system-scoped outer transaction just for this call, which commits
 * immediately after `db.transaction` returns, so there is no later statement
 * in the same outer transaction that the tighter bound could wrongly govern.
 */
const INVENTORY_LOCK_TIMEOUT_MS = 5000;

export type SoftwareInventoryDecisionReason =
  | 'accepted_legacy'
  | 'retained_legacy_empty'
  | 'retained_legacy_after_v2'
  | 'accepted_complete'
  | 'rejected_partial'
  | 'rejected_failed'
  | 'rejected_truncated'
  | 'rejected_count_collapse'
  | 'rejected_out_of_order';

type Decision = {
  acceptedForInventory: boolean;
  absenceResolutionEligible: boolean;
  reasonCode: SoftwareInventoryDecisionReason;
};

type DecisionState = {
  latestReceivedAt: Date | null;
  latestObservationId: string | null;
  hasAcceptedV2: boolean;
  visibleItemCount: number;
  latestAcceptedExpectedSources: string[] | null;
};

export class SoftwareInventoryObservationConflictError extends Error {
  readonly code = 'software_inventory_observation_conflict';
  constructor() {
    super('Software inventory observation conflict');
  }
}

function isV2(report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2): report is SoftwareInventoryObservationV2 {
  return 'schemaVersion' in report && report.schemaVersion === 2;
}

function normalizedSources(sources: readonly string[]): string[] {
  return [...sources].sort((a, b) => a.localeCompare(b));
}

function equalSources(left: readonly string[] | null, right: readonly string[]): boolean {
  if (!left) return false;
  const a = normalizedSources(left);
  const b = normalizedSources(right);
  return a.length === b.length && a.every((source, index) => source === b[index]);
}

export function decideSoftwareInventoryAcceptance(input: {
  report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2;
  state: DecisionState;
  receivedAt: Date;
  observationId?: string;
}): Decision {
  const { report, state, receivedAt } = input;
  const proposedObservationId = input.observationId ?? (isV2(report) ? report.observationId : '');
  if (state.latestReceivedAt && (
    receivedAt.getTime() < state.latestReceivedAt.getTime()
    || (
      receivedAt.getTime() === state.latestReceivedAt.getTime()
      && state.latestObservationId !== null
      && proposedObservationId <= state.latestObservationId
    )
  )) {
    return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'rejected_out_of_order' };
  }

  if (!isV2(report)) {
    if (report.software.length === 0) {
      return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'retained_legacy_empty' };
    }
    if (state.hasAcceptedV2) {
      return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'retained_legacy_after_v2' };
    }
    return { acceptedForInventory: true, absenceResolutionEligible: false, reasonCode: 'accepted_legacy' };
  }

  if (report.truncated) {
    return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'rejected_truncated' };
  }
  if (report.completeness === 'failed') {
    return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'rejected_failed' };
  }
  if (report.completeness === 'partial') {
    return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'rejected_partial' };
  }
  if (
    state.hasAcceptedV2
    && state.visibleItemCount >= 50
    && report.itemCount * 10 < state.visibleItemCount
    && equalSources(state.latestAcceptedExpectedSources, report.expectedSources)
  ) {
    return { acceptedForInventory: false, absenceResolutionEligible: false, reasonCode: 'rejected_count_collapse' };
  }
  return { acceptedForInventory: true, absenceResolutionEligible: true, reasonCode: 'accepted_complete' };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonicalize(item)]));
  }
  return value;
}

function canonicalReport(report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2): unknown {
  if (!isV2(report)) return canonicalize(report);
  return canonicalize({
    ...report,
    expectedSources: normalizedSources(report.expectedSources),
    succeededSources: normalizedSources(report.succeededSources),
    failedSources: [...report.failedSources].sort((a, b) => a.source.localeCompare(b.source)),
  });
}

function digestReport(report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2): string {
  return createHash('sha256').update(JSON.stringify(canonicalReport(report))).digest('hex');
}

function rows<T>(result: unknown): T[] {
  return result as T[];
}

export async function replaceSoftwareInventoryProjection(
  tx: Pick<typeof db, 'select' | 'delete' | 'insert' | 'update'>,
  input: {
    device: { id: string; orgId: string; agentVersion: string | null };
    items: SoftwareInventoryItem[];
    observationId: string;
    receivedAt: Date;
  },
): Promise<void> {
  const { device, items, observationId, receivedAt } = input;
  const linkedFindings = await tx
    .select({ findingId: deviceVulnerabilities.id, name: softwareInventory.name, vendor: softwareInventory.vendor })
    .from(deviceVulnerabilities)
    .innerJoin(softwareInventory, eq(deviceVulnerabilities.softwareInventoryId, softwareInventory.id))
    .where(and(eq(deviceVulnerabilities.deviceId, device.id), eq(softwareInventory.deviceId, device.id)))
    .orderBy(deviceVulnerabilities.id)
    .for('update', { of: deviceVulnerabilities });

  await tx.delete(softwareInventory).where(eq(softwareInventory.deviceId, device.id));

  if (items.length === 0) return;
  await tx.insert(softwareInventory).values(items.map((item) => ({
    deviceId: device.id,
    orgId: device.orgId,
    name: item.name,
    version: resolveInventoryVersion(item.name, item.version, device.agentVersion),
    vendor: item.vendor || null,
    installDate: sanitizeDate(item.installDate),
    installLocation: item.installLocation || null,
    uninstallString: item.uninstallString || null,
    fileHash: item.fileHash || null,
    hashAlgorithm: item.hashAlgorithm || null,
    lastSeen: receivedAt,
    observationId,
  })));

  if (linkedFindings.length === 0) return;
  const findingNames = [...new Set(linkedFindings.map((finding) => finding.name.trim().toLowerCase()))];
  const replacements = await tx
    .select({ id: softwareInventory.id, name: softwareInventory.name, vendor: softwareInventory.vendor })
    .from(softwareInventory)
    .where(and(
      eq(softwareInventory.deviceId, device.id),
      inArray(sql`lower(trim(${softwareInventory.name}))`, findingNames),
    ));

  const key = (name: string, vendor: string | null) => JSON.stringify([
    name.trim().toLowerCase(),
    (vendor ?? '').trim().toLowerCase(),
  ]);
  const replacementByKey = new Map<string, string>();
  for (const replacement of replacements) {
    if (!replacementByKey.has(key(replacement.name, replacement.vendor))) {
      replacementByKey.set(key(replacement.name, replacement.vendor), replacement.id);
    }
  }
  const findingIdsByReplacement = new Map<string, string[]>();
  let severed = 0;
  for (const finding of linkedFindings) {
    const replacementId = replacementByKey.get(key(finding.name, finding.vendor));
    if (!replacementId) {
      severed += 1;
      continue;
    }
    const ids = findingIdsByReplacement.get(replacementId) ?? [];
    ids.push(finding.findingId);
    findingIdsByReplacement.set(replacementId, ids);
  }
  for (const [softwareInventoryId, findingIds] of findingIdsByReplacement) {
    await tx.update(deviceVulnerabilities)
      .set({ softwareInventoryId, updatedAt: receivedAt })
      .where(inArray(deviceVulnerabilities.id, findingIds));
  }
  if (severed > 0) {
    console.warn(`[Inventory] Software report for device ${device.id} severed ${severed} vuln finding link(s) with no replacement row (uninstalled or renamed software)`);
  }
}

type PersistedObservation = {
  id: string;
  org_id: string;
  device_id: string;
  report_digest: string;
  accepted_for_inventory: boolean;
  absence_resolution_eligible: boolean;
  reason_code: SoftwareInventoryDecisionReason;
  visible_item_count: number;
};

export async function ingestSoftwareInventoryReport(input: {
  device: { id: string; orgId: string; agentVersion: string | null };
  report: LegacySoftwareInventoryReport | SoftwareInventoryObservationV2;
  receivedAt: Date;
}): Promise<{
  observationId: string;
  acceptedForInventory: boolean;
  absenceResolutionEligible: boolean;
  reasonCode: SoftwareInventoryDecisionReason;
  visibleItemCount: number;
}> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() =>
    retryOnTransientLockError(`Inventory software device=${input.device.id}`, () => db.transaction(async (tx) => {
      // Each retry attempt opens a NEW savepoint (this `db.transaction` call),
      // and ROLLBACK TO SAVEPOINT undoes a `SET LOCAL` issued after the
      // savepoint — so the bound must be re-applied at the top of every
      // attempt, not just the first.
      await tightenLockTimeout(tx, INVENTORY_LOCK_TIMEOUT_MS);
      const lockedDevice = rows<{ id: string; org_id: string }>(await tx.execute(sql`
        SELECT id, org_id FROM devices
        WHERE id = ${input.device.id}::uuid
        FOR KEY SHARE
      `))[0];
      if (!lockedDevice) throw new Error('Software inventory device not found');
      if (lockedDevice.org_id !== input.device.orgId) throw new Error('Software inventory device organization mismatch');

      const observationId = isV2(input.report) ? input.report.observationId : randomUUID();
      const reportDigest = digestReport(input.report);
      if (isV2(input.report)) {
        // Serialize globally on producer-supplied identity before touching the
        // per-device state row. Two devices can otherwise race the same UUID,
        // with the loser surfacing a raw unique violation after already
        // creating state. The advisory lock makes both exact retry and
        // cross-device collision decisions deterministic and side-effect free.
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${observationId}, 0))
        `);
        const existing = rows<PersistedObservation>(await tx.execute(sql`
          SELECT id, org_id, device_id, report_digest, accepted_for_inventory,
                 absence_resolution_eligible, reason_code, visible_item_count
          FROM software_inventory_observations WHERE id = ${observationId}::uuid
        `))[0];
        if (existing) {
          if (
            existing.org_id !== input.device.orgId
            || existing.device_id !== input.device.id
            || existing.report_digest !== reportDigest
          ) throw new SoftwareInventoryObservationConflictError();
          return {
            observationId: existing.id,
            acceptedForInventory: existing.accepted_for_inventory,
            absenceResolutionEligible: existing.absence_resolution_eligible,
            reasonCode: existing.reason_code,
            visibleItemCount: existing.visible_item_count,
          };
        }
      }

      await tx.execute(sql`
        INSERT INTO device_software_inventory_state (device_id, org_id)
        VALUES (${input.device.id}::uuid, ${input.device.orgId}::uuid)
        ON CONFLICT (device_id) DO NOTHING
      `);
      const state = rows<{
        latest_observation_id: string | null;
        latest_received_at: Date | string | null;
        has_accepted_v2: boolean;
        visible_item_count: number;
        latest_accepted_expected_sources: string[] | null;
      }>(await tx.execute(sql`
        SELECT state.latest_observation_id, latest.received_at AS latest_received_at,
               state.has_accepted_v2, state.visible_item_count,
               accepted.expected_sources AS latest_accepted_expected_sources
        FROM device_software_inventory_state state
        LEFT JOIN software_inventory_observations latest ON latest.id = state.latest_observation_id
        LEFT JOIN software_inventory_observations accepted ON accepted.id = state.latest_accepted_observation_id
        WHERE state.device_id = ${input.device.id}::uuid
        FOR UPDATE OF state
      `))[0];
      if (!state) throw new Error('Software inventory state lock failed');

      const decision = decideSoftwareInventoryAcceptance({
        report: input.report,
        receivedAt: input.receivedAt,
        observationId,
        state: {
          latestReceivedAt: state.latest_received_at ? new Date(state.latest_received_at) : null,
          latestObservationId: state.latest_observation_id,
          hasAcceptedV2: state.has_accepted_v2,
          visibleItemCount: state.visible_item_count,
          latestAcceptedExpectedSources: state.latest_accepted_expected_sources,
        },
      });
      const items = isV2(input.report) ? input.report.items : input.report.software;
      const visibleItemCount = decision.acceptedForInventory ? items.length : state.visible_item_count;
      const observedAt = isV2(input.report) ? new Date(input.report.observedAt) : input.receivedAt;
      const expectedSources = isV2(input.report) ? normalizedSources(input.report.expectedSources) : ['legacy'];
      const succeededSources = isV2(input.report) ? normalizedSources(input.report.succeededSources) : ['legacy'];
      const failedSources = isV2(input.report)
        ? [...input.report.failedSources].sort((a, b) => a.source.localeCompare(b.source))
        : [];

      await tx.execute(sql`
        INSERT INTO software_inventory_observations (
          id, org_id, device_id, schema_version, collector_version, agent_version,
          observed_at, received_at, completeness, truncated,
          claimed_item_count, actual_item_count, expected_sources, succeeded_sources,
          failed_sources, items, report_digest, accepted_for_inventory,
          absence_resolution_eligible, reason_code, visible_item_count
        ) VALUES (
          ${observationId}::uuid, ${input.device.orgId}::uuid, ${input.device.id}::uuid,
          ${isV2(input.report) ? 2 : 1}, ${isV2(input.report) ? input.report.collectorVersion : 'legacy'},
          ${input.device.agentVersion}, ${observedAt.toISOString()}::timestamptz,
          ${input.receivedAt.toISOString()}::timestamptz,
          ${isV2(input.report) ? input.report.completeness : 'complete'},
          ${isV2(input.report) ? input.report.truncated : false},
          ${isV2(input.report) ? input.report.itemCount : items.length}, ${items.length},
          ${JSON.stringify(expectedSources)}::jsonb, ${JSON.stringify(succeededSources)}::jsonb,
          ${JSON.stringify(failedSources)}::jsonb, ${JSON.stringify(items)}::jsonb,
          ${reportDigest}, ${decision.acceptedForInventory}, ${decision.absenceResolutionEligible},
          ${decision.reasonCode}, ${visibleItemCount}
        )
      `);

      if (decision.acceptedForInventory) {
        await replaceSoftwareInventoryProjection(tx, {
          device: input.device,
          items,
          observationId,
          receivedAt: input.receivedAt,
        });
      }

      if (decision.reasonCode !== 'rejected_out_of_order') {
        if (decision.reasonCode === 'accepted_complete') {
          await tx.execute(sql`
            UPDATE device_software_inventory_state SET
              latest_observation_id = ${observationId}::uuid,
              latest_accepted_observation_id = ${observationId}::uuid,
              visible_observation_id = ${observationId}::uuid,
              has_accepted_v2 = true,
              visible_item_count = ${visibleItemCount}, updated_at = now()
            WHERE device_id = ${input.device.id}::uuid
          `);
        } else if (decision.reasonCode === 'accepted_legacy') {
          await tx.execute(sql`
            UPDATE device_software_inventory_state SET
              latest_observation_id = ${observationId}::uuid,
              visible_observation_id = ${observationId}::uuid,
              visible_item_count = ${visibleItemCount}, updated_at = now()
            WHERE device_id = ${input.device.id}::uuid
          `);
        } else {
          await tx.execute(sql`
            UPDATE device_software_inventory_state SET
              latest_observation_id = ${observationId}::uuid, updated_at = now()
            WHERE device_id = ${input.device.id}::uuid
          `);
        }
      }

      return {
        observationId,
        acceptedForInventory: decision.acceptedForInventory,
        absenceResolutionEligible: decision.absenceResolutionEligible,
        reasonCode: decision.reasonCode,
        visibleItemCount,
      };
    })),
  ));
}
