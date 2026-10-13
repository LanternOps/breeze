import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { isTopologyConsumerDefaultPrefix } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { buildFingerprintIndex, classifyDevicePresence, type DevicePresence, type FingerprintRow } from './presenceClassifier';
import { anchorEvidenceFrom, readSitePresenceInputs, type AnchorEvidence, type ObservedAttachment, type SitePresenceInputs } from './presenceInputs';
import { readOrgNetworkDeclarations, type DeclarationSource } from './siteNetworkDeclarations';

/**
 * Presence evaluator (site location W2, spec S§7.2,
 * docs/superpowers/specs/monitoring/2026-10-03-topology-site-location-design.md).
 *
 * One org = one system transaction under a transaction-scoped advisory lock, so replicas never double-evaluate and a
 * reader never sees half an evaluation: fingerprints and presence rows are stamped with the NEW fingerprint_version
 * and the state row only advances to it at the end of the same transaction.
 *
 * It classifies and records. It NEVER writes devices.site_id: no automatic site reassignment, ever (S§2).
 */
export const TOPOLOGY_PRESENCE_INTERVAL_MS = 60_000;
export const PRESENCE_ORGS_PER_TICK = 20;
export const PRESENCE_DIRTY_DEBOUNCE_MS = 30_000;
export const PRESENCE_REEVALUATE_MS = 3_600_000;
export const PRESENCE_FRESH_CAP_MS = 75 * 60_000;
export const FINGERPRINT_CAP = 1024;
export const DECLARING_SITE_CAP = 256;
/** Site graphs read per evaluation (declaring sites plus sites with bound devices). */
export const PRESENCE_SITE_CAP = 1024;
export const DEVICE_CAP = 20_000;
export const PRESENCE_WRITE_BATCH = 1000;
export const ANCHOR_HORIZON_SECONDS = 7 * 86_400;

const OBSERVER_CAP = 64;
const GATEWAY_MAC_CAP = 16;
const DECLARATION_ID_CAP = 32;

type Coverage = 'complete' | 'limited';
export type EvaluateResult = {
  status: 'evaluated' | 'busy' | 'not_configured';
  version: bigint;
  devices: number;
  coverage: Coverage | 'not_configured';
};

export type FingerprintDraft = FingerprintRow & {
  declaredBy: string[]; declarationIds: string[];
  gatewayMacsFull: { mac: string; observerDeviceIds: string[]; lastConfirmedAt: string }[];
};

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Pure (S§6.3): fingerprint rows for one declaring site from its own anchor evidence. */
export function buildSiteFingerprints(input: {
  siteId: string;
  declarations: Map<string, DeclarationSource[]>;
  /** prefix -> every declaring site id */
  declarers: Map<string, string[]>;
  evidence: AnchorEvidence[];
  neighborCoverage: Coverage;
}): FingerprintDraft[] {
  const out: FingerprintDraft[] = [];
  for (const prefix of [...input.declarations.keys()].sort(byText)) {
    const sources = input.declarations.get(prefix)!;
    const ambiguous = (input.declarers.get(prefix) ?? []).length >= 2;
    const base = {
      siteId: input.siteId, prefix, consumerDefault: isTopologyConsumerDefaultPrefix(prefix), neighborCoverage: input.neighborCoverage,
      declaredBy: [...new Set(sources.map((s) => s.kind))].sort(byText),
      declarationIds: [...new Set(sources.map((s) => s.id))].sort(byText).slice(0, DECLARATION_ID_CAP),
    };
    const byGateway = new Map<string, AnchorEvidence[]>();
    for (const e of input.evidence) if (e.prefix === prefix) byGateway.set(e.gateway, [...(byGateway.get(e.gateway) ?? []), e]);
    if (!byGateway.size) {
      out.push({ ...base, gatewayAddress: null, status: ambiguous ? 'ambiguous' : 'unconfirmed', observerDeviceIds: [], gatewayMacs: [], gatewayMacsFull: [] });
      continue;
    }
    for (const gateway of [...byGateway.keys()].sort(byText)) {
      const evidence = byGateway.get(gateway)!;
      const observers = [...new Set(evidence.map((e) => e.observerDeviceId))].sort(byText).slice(0, OBSERVER_CAP);
      const macs = new Map<string, { observers: Set<string>; last: string }>();
      if (input.neighborCoverage === 'complete') {
        for (const e of evidence) {
          if (!e.mac) continue;
          const entry = macs.get(e.mac) ?? { observers: new Set<string>(), last: e.confirmedAt };
          entry.observers.add(e.observerDeviceId);
          if (e.confirmedAt > entry.last) entry.last = e.confirmedAt;
          macs.set(e.mac, entry);
        }
      }
      const gatewayMacsFull = [...macs.entries()]
        .sort(([a, x], [b, y]) => y.observers.size - x.observers.size || byText(a, b))
        .slice(0, GATEWAY_MAC_CAP)
        .map(([mac, entry]) => ({ mac, observerDeviceIds: [...entry.observers].sort(byText).slice(0, OBSERVER_CAP), lastConfirmedAt: entry.last }));
      out.push({
        ...base, gatewayAddress: gateway, status: ambiguous ? 'ambiguous' : 'anchored', observerDeviceIds: observers,
        gatewayMacs: gatewayMacsFull.map(({ mac, observerDeviceIds }) => ({ mac, observerDeviceIds })), gatewayMacsFull,
      });
    }
  }
  return out;
}

/** Pure (S§7.2 step 5): fresh_until = min(earliest supporting fresh_until, now + 75 min). */
export function presenceFreshUntil(presence: DevicePresence, now: Date): Date {
  const cap = now.getTime() + PRESENCE_FRESH_CAP_MS;
  const supporting = presence.attachment && presence.state !== 'stale'
    ? (presence.state === 'home' || presence.state === 'visiting'
      ? [presence.attachment.freshUntil]
      : presence.evidence.map((e) => e.freshUntil))
    : [];
  const times = supporting.map((value) => Date.parse(value)).filter((value) => Number.isFinite(value));
  return new Date(Math.min(cap, ...times));
}

/** Pure: the input digest (diagnostics only). */
export function presenceInputDigest(declarations: Map<string, Map<string, DeclarationSource[]>>, fingerprints: FingerprintDraft[]): string {
  const decl = [...declarations.entries()].sort(([a], [b]) => byText(a, b))
    .map(([site, prefixes]) => [site, [...prefixes.keys()].sort(byText)]);
  const fps = fingerprints.map((f) => [f.siteId, f.prefix, f.gatewayAddress, f.status, f.observerDeviceIds, f.gatewayMacs.map((m) => m.mac)]);
  return createHash('sha256').update(JSON.stringify({ decl, fps })).digest('hex');
}

type Tx = Pick<typeof db, 'execute'>;
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(',')}}`}::uuid[]`;
const textArray = (values: readonly string[]) => sql`${`{${values.map((v) => `"${v.replace(/["\\]/g, '')}"`).join(',')}}`}::text[]`;

async function writeFingerprints(tx: Tx, orgId: string, rows: FingerprintDraft[], version: bigint, now: Date) {
  await tx.execute(sql`DELETE FROM topology_site_fingerprints WHERE org_id = ${orgId}::uuid`);
  const expires = new Date(now.getTime() + PRESENCE_REEVALUATE_MS + PRESENCE_FRESH_CAP_MS).toISOString();
  for (let i = 0; i < rows.length; i += PRESENCE_WRITE_BATCH) {
    const values: SQL[] = rows.slice(i, i + PRESENCE_WRITE_BATCH).map((f) => sql`(${orgId}::uuid, ${f.siteId}::uuid, ${f.prefix}::cidr,
      ${f.gatewayAddress}::inet, ${f.status}, ${f.consumerDefault}, ${textArray(f.declaredBy)}, ${uuidArray(f.declarationIds)},
      ${uuidArray(f.observerDeviceIds)}, ${JSON.stringify(f.gatewayMacsFull)}::jsonb, ${f.neighborCoverage}, ${version.toString()}::bigint,
      ${now.toISOString()}::timestamptz, ${expires}::timestamptz)`);
    await tx.execute(sql`INSERT INTO topology_site_fingerprints (org_id, site_id, prefix, gateway_address, status, consumer_default, declared_by,
      declaration_ids, observer_device_ids, gateway_macs, neighbor_coverage, fingerprint_version, evaluated_at, expires_at)
      VALUES ${sql.join(values, sql`, `)}`);
  }
}

type PresenceDraft = { deviceId: string; assignedSiteId: string; presence: DevicePresence; display: ObservedAttachment | null; freshUntil: Date };

async function writePresence(tx: Tx, orgId: string, drafts: PresenceDraft[], version: bigint, now: Date) {
  for (let i = 0; i < drafts.length; i += PRESENCE_WRITE_BATCH) {
    const values: SQL[] = drafts.slice(i, i + PRESENCE_WRITE_BATCH).map((d) => {
      const p = d.presence;
      const evidence = p.evidence.map((e) => ({
        relationshipIds: e.relationshipIds, observerNodeId: e.observerNodeId, interfaceName: e.interfaceName, confirmedAt: e.confirmedAt,
        freshUntil: e.freshUntil, prefix: e.prefix, gateway: e.gateway, classification: e.classification, reason: e.reason, siteId: e.siteId,
      }));
      const shown = p.attachment ?? d.display;
      return sql`(${d.deviceId}::uuid, ${orgId}::uuid, ${d.assignedSiteId}::uuid, ${p.state}, ${p.reason}, ${p.state === 'visiting' ? p.matchedSiteId : null}::uuid,
        ${uuidArray(p.declaringSiteIds.slice(0, 8))}, ${shown?.prefix ?? null}::cidr, ${shown?.gateway ?? null}::inet, ${shown?.mac ?? null}::macaddr,
        ${p.macCorroborated}, ${JSON.stringify(evidence.slice(0, 8))}::jsonb, ${shown?.confirmedAt ?? null}::timestamptz,
        ${d.freshUntil.toISOString()}::timestamptz, ${version.toString()}::bigint, ${now.toISOString()}::timestamptz)`;
    });
    await tx.execute(sql`INSERT INTO topology_device_presence (device_id, org_id, assigned_site_id, state, reason, matched_site_id, declaring_site_ids,
        prefix, gateway_address, gateway_mac, mac_corroborated, evidence, observed_at, fresh_until, fingerprint_version, evaluated_at)
      VALUES ${sql.join(values, sql`, `)}
      ON CONFLICT (device_id) DO UPDATE SET org_id = EXCLUDED.org_id, assigned_site_id = EXCLUDED.assigned_site_id, state = EXCLUDED.state,
        reason = EXCLUDED.reason, matched_site_id = EXCLUDED.matched_site_id, declaring_site_ids = EXCLUDED.declaring_site_ids,
        prefix = EXCLUDED.prefix, gateway_address = EXCLUDED.gateway_address, gateway_mac = EXCLUDED.gateway_mac,
        mac_corroborated = EXCLUDED.mac_corroborated, evidence = EXCLUDED.evidence, observed_at = EXCLUDED.observed_at,
        fresh_until = EXCLUDED.fresh_until, fingerprint_version = EXCLUDED.fingerprint_version, evaluated_at = EXCLUDED.evaluated_at,
        updated_at = now()`);
  }
}

/** The most recent attachment within the horizon, shown for a stale device ("Last reported …"). */
function lastReported(attachments: ObservedAttachment[]): ObservedAttachment | null {
  return [...attachments].sort((a, b) => byText(b.confirmedAt, a.confirmedAt) || byText(a.prefix, b.prefix) || byText(a.gateway, b.gateway))[0] ?? null;
}

export type EvaluateHooks = { beforeFinalize?: () => Promise<void> };

/** S§7.2. Returns `busy` when another evaluator holds the org's advisory lock. */
export async function evaluateOrgPresence(orgId: string, now = new Date(), hooks: EvaluateHooks = {}): Promise<EvaluateResult> {
  return runOutsideDbContext(() => withSystemDbAccessContext(() => db.transaction(async (tx) => {
    const [lock] = await tx.execute<{ locked: boolean }>(sql`SELECT pg_try_advisory_xact_lock(hashtext(${`topology_presence:${orgId}`})) AS locked`);
    if (!lock?.locked) return { status: 'busy', version: 0n, devices: 0, coverage: 'not_configured' } as EvaluateResult;

    await tx.execute(sql`INSERT INTO topology_org_presence_state (org_id) VALUES (${orgId}::uuid) ON CONFLICT (org_id) DO NOTHING`);
    const [current] = await tx.execute<{ version: string; dirty_seq: string }>(sql`
      SELECT fingerprint_version::text AS version, dirty_seq::text AS dirty_seq FROM topology_org_presence_state WHERE org_id = ${orgId}::uuid`);
    const version = BigInt(current?.version ?? '0') + 1n;
    // Compare-and-clear on the invalidation counter, not on dirty_at: a trigger that fires after our read bumps
    // dirty_seq (dirty_at keeps its first stamp), so its change keeps the org dirty for the next tick.
    const clearDirty = sql`CASE WHEN dirty_seq = ${current?.dirty_seq ?? '0'}::bigint THEN NULL ELSE coalesce(dirty_at, now()) END`;

    const declarations = await readOrgNetworkDeclarations(tx, orgId);
    if (!declarations.bySite.size) {
      await tx.execute(sql`DELETE FROM topology_site_fingerprints WHERE org_id = ${orgId}::uuid`);
      await tx.execute(sql`DELETE FROM topology_device_presence WHERE org_id = ${orgId}::uuid`);
      await hooks.beforeFinalize?.();
      await tx.execute(sql`UPDATE topology_org_presence_state SET fingerprint_version = ${version.toString()}::bigint, coverage = 'not_configured',
        coverage_reason = NULL, evaluated_at = now(), next_evaluation_at = NULL, input_digest = NULL, dirty_at = ${clearDirty}, updated_at = now()
        WHERE org_id = ${orgId}::uuid`);
      return { status: 'not_configured', version, devices: 0, coverage: 'not_configured' } as EvaluateResult;
    }

    let coverage = 'complete' as Coverage;
    let coverageReason: string | null = null;
    const limit = (reason: string) => { coverage = 'limited'; coverageReason ??= reason; };
    if (declarations.truncated) limit('declaration_cap');

    // Declaring sites, id order, capped (S§7.2 step 2).
    const declaringSites = [...declarations.bySite.keys()].sort(byText);
    if (declaringSites.length > DECLARING_SITE_CAP) limit('declaring_site_cap');
    const kept = declaringSites.slice(0, DECLARING_SITE_CAP);
    const declarers = new Map<string, string[]>();
    for (const siteId of kept) for (const prefix of declarations.bySite.get(siteId)!.keys()) declarers.set(prefix, [...(declarers.get(prefix) ?? []), siteId]);

    // Every site whose graph holds a device assigned to it, plus the declaring sites.
    const bound = await tx.execute<{ site_id: string }>(sql`SELECT DISTINCT b.site_id::text AS site_id FROM topology_node_bindings b
      JOIN devices d ON d.id = b.device_id AND d.org_id = b.org_id AND d.site_id = b.site_id
      WHERE b.org_id = ${orgId}::uuid AND b.device_id IS NOT NULL ORDER BY 1 LIMIT ${PRESENCE_SITE_CAP + 1}`);
    const siteIds = [...new Set([...kept, ...[...bound].map((r) => r.site_id)])].sort(byText);
    if (bound.length > PRESENCE_SITE_CAP || siteIds.length > PRESENCE_SITE_CAP) limit('site_cap');
    const inputs = new Map<string, SitePresenceInputs>();
    for (const siteId of siteIds.slice(0, PRESENCE_SITE_CAP)) {
      const read = await readSitePresenceInputs(tx, { orgId, siteId }, now, ANCHOR_HORIZON_SECONDS);
      if (read.truncated) limit('relationship_cap');
      inputs.set(siteId, read);
    }

    // Fingerprints (S§6.3, S§7.2 step 3).
    let fingerprints: FingerprintDraft[] = [];
    for (const siteId of kept) {
      const own = declarations.bySite.get(siteId)!;
      const siteInputs = inputs.get(siteId);
      fingerprints.push(...buildSiteFingerprints({
        siteId, declarations: own, declarers,
        evidence: siteInputs ? anchorEvidenceFrom(siteInputs, own.keys()) : [],
        neighborCoverage: siteInputs?.neighborCoverage ?? 'limited',
      }));
    }
    if (fingerprints.length > FINGERPRINT_CAP) { limit('fingerprint_cap'); fingerprints = fingerprints.slice(0, FINGERPRINT_CAP); }
    const index = buildFingerprintIndex(fingerprints, coverage);

    // Devices (S§7.2 step 4), id order within site order, capped.
    const drafts: PresenceDraft[] = [];
    outer: for (const [siteId, siteInputs] of inputs) {
      for (const deviceId of siteInputs.devices) {
        if (drafts.length >= DEVICE_CAP) { limit('device_cap'); break outer; }
        const observed = siteInputs.attachments.get(deviceId) ?? [];
        const presence = classifyDevicePresence({
          deviceId, assignedSiteId: siteId, index, now,
          attachments: observed.map(({ anchorMac: _anchorMac, ...a }) => a),
        });
        drafts.push({ deviceId, assignedSiteId: siteId, presence, display: presence.attachment ? null : lastReported(observed), freshUntil: presenceFreshUntil(presence, now) });
      }
    }
    // A cap reached mid-way turns already-classified would-be visits into unknown, as the classifier would.
    const finalIndex = coverage === 'limited' && index.coverage === 'complete' ? buildFingerprintIndex(fingerprints, 'limited') : index;
    if (finalIndex !== index) {
      for (const d of drafts) {
        const observed = inputs.get(d.assignedSiteId)!.attachments.get(d.deviceId) ?? [];
        d.presence = classifyDevicePresence({ deviceId: d.deviceId, assignedSiteId: d.assignedSiteId, index: finalIndex, now,
          attachments: observed.map(({ anchorMac: _anchorMac, ...a }) => a) });
        d.freshUntil = presenceFreshUntil(d.presence, now);
      }
    }

    await writeFingerprints(tx, orgId, fingerprints, version, now);
    await writePresence(tx, orgId, drafts, version, now);
    // Devices no longer bound (or past the cap) lose their row (S§7.2: rows only for evaluated devices).
    await tx.execute(sql`DELETE FROM topology_device_presence WHERE org_id = ${orgId}::uuid
      AND NOT (device_id = ANY(${uuidArray(drafts.map((d) => d.deviceId))}))`);

    await hooks.beforeFinalize?.();
    await tx.execute(sql`UPDATE topology_org_presence_state SET fingerprint_version = ${version.toString()}::bigint, coverage = ${coverage},
      coverage_reason = ${coverageReason}, evaluated_at = now(), next_evaluation_at = now() + make_interval(secs => ${PRESENCE_REEVALUATE_MS / 1000}),
      input_digest = ${presenceInputDigest(declarations.bySite, fingerprints)}, dirty_at = ${clearDirty}, updated_at = now()
      WHERE org_id = ${orgId}::uuid`);
    return { status: 'evaluated', version, devices: drafts.length, coverage } as EvaluateResult;
  }), 'topology presence evaluation'));
}
