/**
 * W06 (#7604): the one write of a gateway verification record onto
 * `partner_ai_models.capabilities` (Decision D4). Nothing else may write that
 * column for a gateway kind — it is what grants tool calling.
 *
 * Runs through the W04 registry write model (offeringWrites.inPartnerRegistryWrite):
 * its own system transaction behind the partner registry try-lock, every
 * statement pinned to the partner. The verifier is a background job, so a busy
 * lock is retried a few times here rather than surfaced as a 503.
 *
 * Superseded rule: the result of a run belongs to the connection state it ran
 * against. If, under the row lock, the connection is no longer active, is no
 * longer a gateway kind, has a different config_version (endpoint OR key
 * changed) or a different endpoint fingerprint, or the offering has moved or
 * already carries a record from a run that finished after this one started,
 * nothing is written. So an old run never stamps a record onto a new endpoint
 * and never overwrites a newer verdict (a run with a since-rotated key cannot
 * un-verify a model the admin just fixed).
 *
 * Writes capabilities + updated_at only: never enabled, prices or anything else.
 *
 * #11397: the run's per-surface `surface_turn` entries are merged into the
 * stored `breeze_surface_readiness` map under the same lock (other surfaces'
 * entries are kept). An entry whose surface now resolves to another tool
 * profile than the run used (the profile, allow-list or effective window
 * changed under the run) is dropped: superseded per surface, never written.
 */
import { and, eq, or, sql } from 'drizzle-orm';
import { TOOL_REQUIRING_SURFACES, isGatewayConnectionKind, type AiSurface } from '@breeze/shared';
import { db } from '../../db';
import { aiModelAssignments, partnerAiConnections, partnerAiModels } from '../../db/schema';
import { SURFACE_READINESS_KEY, currentReadinessEntries, mergeSurfaceReadiness, type SurfaceReadinessMap } from './surfaceReadiness';
import { endpointFingerprint, readVerification } from './gatewayCapabilities';
import { inPartnerRegistryWrite } from './offeringWrites';
import { RegistryWriteError } from './registryWriteErrors';

export interface OfferingVerificationWrite {
  partnerId: string;
  offeringId: string;
  connectionId: string;
  modelId: string;
  /** The connection's config_version the run was built from. */
  configVersion: number;
  /** endpointFingerprint of the connection the run was built from (also inside the record). */
  endpointFingerprint: string;
  /** When the run started; a record that finished at or after this wins. */
  startedAt: Date;
  /** verifiedCapabilitiesTree(record, …). */
  capabilities: Record<string, unknown>;
  /** #11397: this run's surface_turn entries (merged into the stored map). */
  surfaceReadiness?: SurfaceReadinessMap;
}

/**
 * `connection_changed`: nothing written because the connection, still active,
 * now has a different config_version or endpoint fingerprint (a fresh run
 * would verify it). `superseded`: nothing written for any other reason (gone,
 * disconnected, offering moved, or a newer verdict already landed).
 */
export type OfferingVerificationWriteOutcome = 'written' | 'superseded' | 'connection_changed';

const BUSY_RETRIES = 5;
const BUSY_BACKOFF_MS = 500;

async function writeLocked(input: OfferingVerificationWrite): Promise<OfferingVerificationWriteOutcome> {
  const [conn] = await db
    .select({
      kind: partnerAiConnections.kind,
      status: partnerAiConnections.status,
      baseUrl: partnerAiConnections.baseUrl,
      providerConfig: partnerAiConnections.providerConfig,
      configVersion: partnerAiConnections.configVersion,
    })
    .from(partnerAiConnections)
    .where(and(eq(partnerAiConnections.id, input.connectionId), eq(partnerAiConnections.partnerId, input.partnerId)))
    .for('update');
  if (!conn || conn.status !== 'active' || !isGatewayConnectionKind(conn.kind)) return 'superseded';
  if (
    conn.configVersion !== input.configVersion
    || endpointFingerprint({ kind: conn.kind, baseUrl: conn.baseUrl, providerConfig: conn.providerConfig ?? null }) !== input.endpointFingerprint
  ) {
    return 'connection_changed';
  }

  const [offering] = await db
    .select({
      capabilities: partnerAiModels.capabilities,
      toolProfile: partnerAiModels.toolProfile,
      toolAllowlist: partnerAiModels.toolAllowlist,
      contextWindowOverride: partnerAiModels.contextWindowOverride,
      contextWindowDiscovered: partnerAiModels.contextWindowDiscovered,
      contextWindowObserved: partnerAiModels.contextWindowObserved,
      contextWindowObservedAt: partnerAiModels.contextWindowObservedAt,
      contextWindowObservedConfigVersion: partnerAiModels.contextWindowObservedConfigVersion,
    })
    .from(partnerAiModels)
    .where(and(
      eq(partnerAiModels.id, input.offeringId),
      eq(partnerAiModels.partnerId, input.partnerId),
      eq(partnerAiModels.connectionId, input.connectionId),
      eq(partnerAiModels.modelId, input.modelId),
    ))
    .for('update');
  if (!offering) return 'superseded';
  const existing = readVerification(offering.capabilities);
  if (existing && Date.parse(existing.at) >= input.startedAt.getTime()) return 'superseded';

  const { kept, dropped } = currentReadinessEntries(input.surfaceReadiness ?? {}, offering, conn.configVersion);
  if (dropped.length > 0) {
    console.info(`[aiModels] offering ${input.offeringId}: surface turn(s) superseded by a tool profile change: ${dropped.join(', ')}`);
  }
  const readiness = mergeSurfaceReadiness(offering.capabilities, kept);
  const capabilities = Object.keys(readiness).length > 0
    ? { ...input.capabilities, [SURFACE_READINESS_KEY]: readiness }
    : input.capabilities;

  await db
    .update(partnerAiModels)
    .set({ capabilities, updatedAt: new Date() })
    .where(and(eq(partnerAiModels.id, input.offeringId), eq(partnerAiModels.partnerId, input.partnerId)));
  return 'written';
}

export async function writeOfferingVerification(
  input: OfferingVerificationWrite,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<OfferingVerificationWriteOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await inPartnerRegistryWrite(
        input.partnerId,
        'aiModels.writeOfferingVerification',
        'Could not save the verification result.',
        () => writeLocked(input),
      );
    } catch (error) {
      if (error instanceof RegistryWriteError && error.code === 'registry_busy' && attempt < BUSY_RETRIES) {
        await sleep(BUSY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
}

/**
 * #11397: the tool surfaces an offering is explicitly assigned to on any of
 * its partner's assignment rows (partner or org level): as the default, in a
 * permitted list or in a fallback list. A row that permits every model
 * (permitted list NULL) does not name it, so it does not count: verification
 * runs a surface turn only where the offering was deliberately put.
 */
export async function listOfferingToolSurfaces(partnerId: string, offeringId: string): Promise<AiSurface[]> {
  const rows = await db
    .selectDistinct({ surface: aiModelAssignments.surface })
    .from(aiModelAssignments)
    .where(and(
      eq(aiModelAssignments.offeringPartnerId, partnerId),
      or(
        eq(aiModelAssignments.defaultOfferingId, offeringId),
        sql`${offeringId}::uuid = ANY(${aiModelAssignments.permittedOfferingIds})`,
        sql`${offeringId}::uuid = ANY(${aiModelAssignments.fallbackOfferingIds})`,
      ),
    ));
  const found = new Set(rows.map((r) => r.surface));
  return (TOOL_REQUIRING_SURFACES as readonly AiSurface[]).filter((s) => found.has(s));
}
