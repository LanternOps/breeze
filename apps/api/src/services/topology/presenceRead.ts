import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  presenceResponseSchema,
  type PresenceAssignedEntry, type PresenceDeclaredNetwork, type PresenceReason, type PresenceResponse, type PresenceSiteRef, type PresenceSuggestion,
  type PresenceVisitor,
} from '@breeze/shared';
import { db } from '../../db';
import type { TopologyRequestContext } from './access';
import { graphAuthority, topologyReadEtag } from './graphCursor';
import { siteVisibility } from './presenceVisibility';
import { readSiteNetworkDeclarations } from './siteNetworkDeclarations';

/**
 * Site-gated presence read (site location W2, spec S§8, S§9): `GET /topology/sites/:siteId/presence`.
 *
 * Runs in the request's org RLS context and then applies the app-layer site gate (presenceVisibility.ts):
 *  R2 a site other than the viewed one is named only when visible;
 *  R3 a visitor appears on the viewed site only when its owner site is visible — filtered in SQL BEFORE the limit,
 *     so a hidden visitor leaves no count, no "+N" and no truncation hint;
 *  R4 a hidden match serializes byte-for-byte as an unrecognized entry with `reason: null` (one code path,
 *     `asUnrecognized`), and `not_declared` is never serialized;
 *  R6 visitor DTOs carry the device id and a presentation id only — never canonical node, relationship or
 *     interface ids (the evidence column is never read here).
 *  W3 suggestions (S§10.2, R5): an assigned entry carries its suggestion only on the visiting branch whose matched site
 *     is visible and equals the stored suggestion (it names B); a visitor carries one only when it suggests the viewed
 *     site (the visitor itself already required its owner site). Hidden and not-current entries never carry one.
 * Every response is `authority: false`: presence is presentation, never a site assignment.
 */
export const PRESENCE_ASSIGNED_LIMIT = 1000;
export const PRESENCE_VISITOR_LIMIT = 500;
const SITE_NAME_CAP = 10_000;

type PresenceRow = {
  device_id: string; label: string; device_site_id: string; assigned_site_id: string; state: string; reason: string | null;
  matched_site_id: string | null; declaring_site_ids: string[] | null; prefix: string | null; gateway_address: string | null;
  mac_corroborated: boolean; observed_at: string | null; fresh_until: string | null; version_ok: boolean; fresh: boolean;
  suggested_site_id: string | null; suggestion_days: number | null; suggestion_first_at: string | null; suggestion_last_at: string | null;
  confirmed_at: string | null;
};
type FingerprintRow = { prefix: string; site_id: string; declared_by: string[] | null; gateway_address: string | null; status: string };

/** Reasons that name the assigned (viewed) site A, or the single declaring site B (S§8 R4). */
const NAMES_VIEWED_SITE: ReadonlySet<string> = new Set(['own_gateway_mismatch', 'own_gateway_mac_conflict']);
const NAMES_DECLARING_SITE: ReadonlySet<string> = new Set(['declared_unconfirmed', 'gateway_mismatch', 'consumer_uncorroborated', 'gateway_mac_conflict']);

const iso = (value: string | Date | null): string | null => (value === null ? null : new Date(value).toISOString());
const network = (row: PresenceRow) => (row.prefix && row.gateway_address ? { prefix: row.prefix, gatewayAddress: row.gateway_address } : null);
const uuidList = (value: string[] | string | null): string[] => {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return value.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
  return [];
};

/** The single serialization of an entry that must look unrecognized (hidden match, not_declared, hidden ambiguity). */
function asUnrecognized(row: PresenceRow): PresenceAssignedEntry {
  return {
    deviceId: row.device_id, label: row.label, state: 'unrecognized', reason: null, matchedSite: null, declaringSites: null,
    network: network(row), macCorroborated: false, observedAt: iso(row.observed_at), freshUntil: iso(row.fresh_until), suggestion: null,
    siteAssignmentConfirmedAt: iso(row.confirmed_at),
  };
}
function asNotCurrent(row: PresenceRow): PresenceAssignedEntry {
  return {
    deviceId: row.device_id, label: row.label, state: 'unknown', reason: 'not_current', matchedSite: null, declaringSites: null,
    network: network(row), macCorroborated: false, observedAt: iso(row.observed_at), freshUntil: iso(row.fresh_until), suggestion: null,
    siteAssignmentConfirmedAt: iso(row.confirmed_at),
  };
}
/**
 * The stored suggestion, if it names `site` (a ref the caller has already gated) and is complete. A confirmed device
 * ("Keep at <site>") carries none even before the evaluator next clears the stored suggestion (S§11 suppression).
 */
function suggestionFor(row: PresenceRow, site: PresenceSiteRef): PresenceSuggestion | null {
  if (row.confirmed_at || row.suggested_site_id !== site.id || row.suggestion_days === null || !row.suggestion_first_at || !row.suggestion_last_at) return null;
  return { siteId: site.id, siteName: site.name, days: row.suggestion_days, firstObservedAt: iso(row.suggestion_first_at)!, lastObservedAt: iso(row.suggestion_last_at)! };
}

export async function readSitePresence(ctx: TopologyRequestContext, now = new Date()): Promise<{ body: PresenceResponse; etag: string }> {
  const authority = await graphAuthority(ctx);
  const visible = siteVisibility(ctx, authority.current);
  const { orgId, siteId } = ctx.scope;

  const body = await db.transaction(async (tx) => {
    const [state] = await tx.execute<{ version: string; coverage: 'complete' | 'limited' | 'not_configured'; evaluated_at: string | null }>(sql`
      SELECT fingerprint_version::text AS version, coverage, evaluated_at FROM topology_org_presence_state WHERE org_id = ${orgId}::uuid`);
    const version = state?.version ?? '0';
    const coverage = state?.coverage ?? 'not_configured';
    // Site names: looked up for the org once, and only ever emitted for visible ids.
    const siteRows = await tx.execute<{ id: string; name: string }>(sql`SELECT id::text AS id, name FROM sites WHERE org_id = ${orgId}::uuid
      ORDER BY id LIMIT ${SITE_NAME_CAP}`);
    const names = new Map([...siteRows].map((r) => [r.id, r.name]));
    const visibleIds = [...names.keys()].filter((id) => id !== siteId && visible(id));
    const ref = (id: string | null): PresenceSiteRef | null => (id && (id === siteId || visible(id)) && names.has(id) ? { id, name: names.get(id)! } : null);
    const declarations = await readSiteNetworkDeclarations(tx, ctx.scope);

    const empty: PresenceResponse = {
      schemaVersion: 1, siteId, asOf: iso(state?.evaluated_at ?? null) ?? new Date(0).toISOString(), authority: false, coverage,
      ignoredDeclarations: declarations.ignored, declaredNetworks: [], assigned: [], visitors: [],
      counts: { observedElsewhere: 0, unidentified: 0, unknown: 0, visiting: 0 }, truncated: { assigned: false, visitors: false },
    };
    if (coverage === 'not_configured') return empty;

    const columns = sql`p.device_id::text AS device_id, coalesce(nullif(btrim(d.display_name), ''), d.hostname) AS label,
      d.site_id::text AS device_site_id, p.assigned_site_id::text AS assigned_site_id, p.state, p.reason, p.matched_site_id::text AS matched_site_id,
      p.declaring_site_ids::text[] AS declaring_site_ids, p.prefix::text AS prefix, host(p.gateway_address) AS gateway_address,
      p.mac_corroborated, p.observed_at, p.fresh_until, (p.fingerprint_version = ${version}::bigint) AS version_ok,
      (p.fresh_until IS NOT NULL AND p.fresh_until > ${now.toISOString()}::timestamptz) AS fresh,
      p.suggested_site_id::text AS suggested_site_id, p.suggestion_days, p.suggestion_first_at, p.suggestion_last_at,
      d.site_assignment_confirmed_at AS confirmed_at`;

    // (a) Devices assigned (live) to the viewed site that are not validly home.
    const assignedRows = [...await tx.execute<PresenceRow>(sql`SELECT ${columns}
      FROM topology_device_presence p JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
      WHERE p.org_id = ${orgId}::uuid AND d.site_id = ${siteId}::uuid
        AND (p.state <> 'home' OR p.fingerprint_version <> ${version}::bigint OR p.fresh_until IS NULL
          OR p.fresh_until <= ${now.toISOString()}::timestamptz OR p.assigned_site_id <> d.site_id)
      ORDER BY label, p.device_id LIMIT ${PRESENCE_ASSIGNED_LIMIT + 1}`)];

    // (b) Valid visits to the viewed site by devices of OTHER, VISIBLE sites (R3: filtered before the limit).
    const visitorRows = coverage === 'complete' && visibleIds.length ? [...await tx.execute<PresenceRow>(sql`SELECT ${columns}
      FROM topology_device_presence p JOIN devices d ON d.id = p.device_id AND d.org_id = p.org_id
      WHERE p.org_id = ${orgId}::uuid AND p.state = 'visiting' AND p.matched_site_id = ${siteId}::uuid
        AND d.site_id <> ${siteId}::uuid AND p.assigned_site_id = d.site_id
        AND d.site_id = ANY(${`{${visibleIds.join(',')}}`}::uuid[])
        AND p.fingerprint_version = ${version}::bigint AND p.fresh_until > ${now.toISOString()}::timestamptz
      ORDER BY label, p.device_id LIMIT ${PRESENCE_VISITOR_LIMIT + 1}`)] : [];

    // (c) The viewed site's fingerprints, plus which other sites declare the same prefixes (ambiguity is shown only
    //     when every declarer is visible).
    const fingerprints = [...await tx.execute<FingerprintRow>(sql`SELECT f.prefix::text AS prefix, f.site_id::text AS site_id, f.declared_by,
        host(f.gateway_address) AS gateway_address, f.status
      FROM topology_site_fingerprints f
      WHERE f.org_id = ${orgId}::uuid AND f.fingerprint_version = ${version}::bigint
        AND f.prefix IN (SELECT o.prefix FROM topology_site_fingerprints o WHERE o.org_id = ${orgId}::uuid AND o.site_id = ${siteId}::uuid)
      ORDER BY f.prefix, f.site_id LIMIT 4096`)];

    const declaredNetworks: PresenceDeclaredNetwork[] = [];
    const byPrefix = new Map<string, FingerprintRow[]>();
    for (const row of fingerprints) byPrefix.set(row.prefix, [...(byPrefix.get(row.prefix) ?? []), row]);
    for (const [prefix, rows] of byPrefix) {
      const own = rows.filter((r) => r.site_id === siteId);
      if (!own.length) continue;
      const declarers = [...new Set(rows.map((r) => r.site_id))];
      const gateways = [...new Set(own.map((r) => r.gateway_address).filter((g): g is string => !!g))].sort().slice(0, 16);
      const ambiguousVisible = declarers.length >= 2 && declarers.every((id) => id === siteId || visible(id));
      declaredNetworks.push({
        prefix,
        sources: [...new Set(own.flatMap((r) => uuidList(r.declared_by)))].filter((s): s is 'discovery_profile' | 'network_baseline' =>
          s === 'discovery_profile' || s === 'network_baseline').sort().slice(0, 2),
        status: ambiguousVisible ? 'ambiguous' : gateways.length ? 'anchored' : 'unconfirmed',
        gatewayAddresses: gateways,
      });
    }

    const assigned: PresenceAssignedEntry[] = [];
    for (const row of assignedRows.slice(0, PRESENCE_ASSIGNED_LIMIT)) {
      const valid = row.version_ok && row.fresh && row.assigned_site_id === row.device_site_id && (row.state !== 'visiting' || coverage === 'complete');
      if (!valid) { assigned.push(asNotCurrent(row)); continue; }
      const base = { deviceId: row.device_id, label: row.label, network: network(row), observedAt: iso(row.observed_at), freshUntil: iso(row.fresh_until),
        suggestion: null, siteAssignmentConfirmedAt: iso(row.confirmed_at) };
      switch (row.state) {
        case 'visiting': {
          const matched = row.matched_site_id && row.matched_site_id !== siteId ? ref(row.matched_site_id) : null;
          assigned.push(matched
            ? { ...base, state: 'visiting', reason: null, matchedSite: matched, declaringSites: null, macCorroborated: row.mac_corroborated,
              suggestion: suggestionFor(row, matched) }
            : asUnrecognized(row));
          break;
        }
        case 'unrecognized': {
          const reason = row.reason as PresenceReason | null;
          if (reason && NAMES_VIEWED_SITE.has(reason)) {
            assigned.push({ ...base, state: 'unrecognized', reason, matchedSite: null, declaringSites: [ref(siteId)!], macCorroborated: false });
          } else if (reason && NAMES_DECLARING_SITE.has(reason)) {
            const declarers = uuidList(row.declaring_site_ids);
            const named = declarers.length === 1 && declarers[0] !== siteId ? ref(declarers[0]!) : null;
            assigned.push(named
              ? { ...base, state: 'unrecognized', reason, matchedSite: null, declaringSites: [named], macCorroborated: false }
              : asUnrecognized(row));
          } else {
            assigned.push(asUnrecognized(row)); // not_declared and anything unnamed
          }
          break;
        }
        case 'ambiguous': {
          const declarers = uuidList(row.declaring_site_ids);
          const refs = declarers.map((id) => ref(id));
          assigned.push(declarers.length >= 2 && refs.every((r) => r !== null)
            ? { ...base, state: 'ambiguous', reason: 'multiply_declared', matchedSite: null, declaringSites: refs as PresenceSiteRef[], macCorroborated: false }
            : asUnrecognized(row));
          break;
        }
        case 'stale':
          assigned.push({ ...base, state: 'stale', reason: 'no_fresh_observation', matchedSite: null, declaringSites: null, macCorroborated: false });
          break;
        case 'unknown':
          assigned.push({ ...base, state: 'unknown', reason: 'coverage_limited', matchedSite: null, declaringSites: null, macCorroborated: false });
          break;
        default:
          // A valid 'home' row is never selected; anything else is not current.
          assigned.push(asNotCurrent(row));
      }
    }

    const scopeHash = createHash('sha256').update(`presence:${authority.digest}:${siteId}`).digest('hex').slice(0, 24);
    const visitors: PresenceVisitor[] = visitorRows.slice(0, PRESENCE_VISITOR_LIMIT).flatMap((row) => {
      const owner = ref(row.device_site_id);
      const net = network(row);
      if (!owner || !net) return [];
      return [{
        id: `presentation:overview:${scopeHash}:visitor-${createHash('sha256').update(row.device_id).digest('hex').slice(0, 40)}`,
        deviceId: row.device_id, label: row.label, assignedSite: owner, network: net, macCorroborated: row.mac_corroborated,
        observedAt: iso(row.observed_at), freshUntil: iso(row.fresh_until), suggestion: suggestionFor(row, ref(siteId)!),
        siteAssignmentConfirmedAt: iso(row.confirmed_at),
      }];
    });

    return {
      ...empty,
      declaredNetworks: declaredNetworks.slice(0, 256),
      assigned,
      visitors,
      counts: {
        observedElsewhere: assigned.filter((x) => x.state === 'visiting').length,
        unidentified: assigned.filter((x) => x.state === 'unrecognized' || x.state === 'ambiguous').length,
        unknown: assigned.filter((x) => x.state === 'stale' || x.state === 'unknown').length,
        visiting: visitors.length,
      },
      truncated: { assigned: assignedRows.length > PRESENCE_ASSIGNED_LIMIT, visitors: visitorRows.length > PRESENCE_VISITOR_LIMIT },
    } satisfies PresenceResponse;
  });

  const parsed = presenceResponseSchema.parse(body);
  return { body: parsed, etag: topologyReadEtag(authority.digest, parsed) };
}
