import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

// ---------------------------------------------------------------------------
// Recidivist-endpoint detector: rmm.recidivist_endpoint
//
// The corpus (abuse_endpoint_fingerprints, Task 1) records three kinds of
// endpoint fingerprint — remote_tool_guid, hostname, egress_ip — extracted
// for EVERY partner regardless of status, mirroring the scriptContent.ts
// corpus rule: a suspended partner's fingerprints must stay in the corpus or
// the very correlation this detector exists for (a suspended operator
// re-enrolling the same box under a fresh signup) becomes invisible.
//
// syncEndpointFingerprints() refreshes that corpus. loadRecidivistMatches()
// does the cross-partner correlation entirely in SQL and returns raw matches
// — scoring (max-of-axes, never sum; no age decay) is a separate concern
// left to the caller/scorer (Task 3), same split as loadScriptFindings vs.
// computeScriptSignals.
//
// Full-scan, no high-water mark: at current fleet size (~hundreds of
// devices) a full re-derive of the corpus every sweep is cheap and, unlike
// scriptContent's execution-stdout scan, there is no unboundedly-growing
// event log here to make incremental scanning worth the extra state — every
// row we'd scan is current device/software-inventory state, not history.
// ---------------------------------------------------------------------------

/**
 * ScreenConnect embeds its client GUID directly in the installed-software
 * display name: "ScreenConnect Client (0123456789abcdef)". v1 ships this
 * pattern only — LogMeIn and others are unbacktested against real inventory
 * data, and this detector fires at score 100, so an unverified pattern does
 * not ship (see Global Constraints).
 *
 * Pattern is exactly the brief's spec, case-sensitive (ScreenConnect always
 * emits this exact label + lowercase hex — a looser match risks false
 * positives at score 100). Pure; exported for tests. `g` flag so a name
 * mentioning the client twice (seen in some inventory dedupe edge cases)
 * yields both.
 */
const SCREENCONNECT_GUID_RE = /ScreenConnect Client \(([0-9a-f]{16})\)/g;

export function extractScreenConnectGuids(name: string): string[] {
  const out = new Set<string>();
  for (const match of name.matchAll(SCREENCONNECT_GUID_RE)) {
    const guid = match[1];
    if (guid) out.add(guid.toLowerCase());
  }
  return [...out];
}

// SQL-side prefilter mirroring SCREENCONNECT_GUID_RE, so software_inventory
// rows that cannot possibly match never leave Postgres.
const SCREENCONNECT_GUID_SQL_RE = 'ScreenConnect Client \\([0-9a-f]{16}\\)';

/** A denied `WIN-` prefix must be shorter than this many characters total. */
const WIN_PREFIX_DENY_MAX_LENGTH = 12;

/**
 * Hostnames that must never enter the corpus as a `hostname` fingerprint:
 * empty/blank, `localhost`, and any short auto-generated `WIN-` default
 * (Windows Setup stamps `WIN-<10 random chars>`, which is exactly the kind
 * of unrenamed-installer-default noise that would pollute cross-partner
 * correlation with false positives rather than catch a real recidivist).
 *
 * Pure; exported for tests. Expects an already-lowercased/trimmed value —
 * callers normalize before checking (and before storing) so the deny-list
 * and the stored value agree on casing.
 */
export function isDeniedHostname(h: string): boolean {
  const trimmed = h.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'localhost') return true;
  if (lower.startsWith('win-') && lower.length < WIN_PREFIX_DENY_MAX_LENGTH) return true;
  return false;
}

interface FingerprintRow {
  partnerId: string;
  kind: 'remote_tool_guid' | 'hostname' | 'egress_ip';
  value: string;
  deviceId: string;
}

interface SoftwareInventoryRow {
  device_id: string;
  partner_id: string;
  name: string;
}

interface DeviceRow {
  id: string;
  partner_id: string;
  hostname: string;
  last_seen_ip: string | null;
  enrollment_ip: string | null;
}

/**
 * Refreshes the abuse_endpoint_fingerprints corpus from current device and
 * software-inventory state. MUST run inside a system DB context — this
 * corpus is system-only RLS (bare breeze_app reads return 0 rows), and the
 * sweep already provides that context (see class header).
 */
export async function syncEndpointFingerprints(now: Date): Promise<void> {
  // --- 1. remote_tool_guid: ScreenConnect client GUIDs from software_inventory,
  //        SQL-prefiltered before any name text leaves Postgres. -------------
  const softwareRows = (await db.execute(sql`
    SELECT si.device_id, o.partner_id, si.name
    FROM software_inventory si
    JOIN devices d ON d.id = si.device_id
    JOIN organizations o ON o.id = d.org_id
    WHERE si.name ~ ${SCREENCONNECT_GUID_SQL_RE}
  `)) as unknown as SoftwareInventoryRow[];

  // --- 2. hostname + egress_ip: current device state, all partners. --------
  const deviceRows = (await db.execute(sql`
    SELECT d.id, o.partner_id, d.hostname, d.last_seen_ip, d.enrollment_ip
    FROM devices d
    JOIN organizations o ON o.id = d.org_id
  `)) as unknown as DeviceRow[];

  // --- 3. Build the fingerprint set. De-duplicated by (partnerId, kind,
  //        value) so the batched upsert below never targets the same row
  //        twice in one statement (Postgres rejects that under
  //        ON CONFLICT DO UPDATE). Last-observed device wins on collision —
  //        same tie-break scriptContent.ts uses for its host upserts. -------
  const byKey = new Map<string, FingerprintRow>();
  const record = (row: FingerprintRow) => byKey.set(`${row.partnerId}|${row.kind}|${row.value}`, row);

  for (const r of softwareRows) {
    for (const guid of extractScreenConnectGuids(r.name)) {
      record({ partnerId: r.partner_id, kind: 'remote_tool_guid', value: guid, deviceId: r.device_id });
    }
  }

  for (const r of deviceRows) {
    const hostname = (r.hostname ?? '').trim().toLowerCase();
    if (!isDeniedHostname(hostname)) {
      record({ partnerId: r.partner_id, kind: 'hostname', value: hostname, deviceId: r.id });
    }

    const ip = (r.last_seen_ip ?? r.enrollment_ip ?? '').trim();
    if (ip.length > 0) {
      record({ partnerId: r.partner_id, kind: 'egress_ip', value: ip, deviceId: r.id });
    }
  }

  const rows = [...byKey.values()];
  if (rows.length === 0) return;

  const values = sql.join(
    rows.map(
      (r) =>
        sql`(${r.partnerId}::uuid, ${r.kind}::abuse_endpoint_fingerprint_kind, ${r.value}, ${r.deviceId}::uuid, ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );

  await db.execute(sql`
    INSERT INTO abuse_endpoint_fingerprints (partner_id, kind, value, device_id, first_seen_at, last_seen_at)
    VALUES ${values}
    ON CONFLICT (partner_id, kind, value) DO UPDATE SET
      last_seen_at = EXCLUDED.last_seen_at,
      device_id = COALESCE(abuse_endpoint_fingerprints.device_id, EXCLUDED.device_id)
  `);
}

export interface RecidivistMatch {
  partnerId: string;
  kind: 'remote_tool_guid' | 'hostname' | 'egress_ip';
  value: string;
  otherPartnerId: string;
  otherPartnerName: string;
  otherPartnerStatus: string;
}

interface MatchRow {
  partner_id: string;
  kind: 'remote_tool_guid' | 'hostname' | 'egress_ip';
  value: string;
  other_partner_id: string;
  other_partner_name: string;
  other_partner_status: string;
}

interface ScannedPartnerRow {
  partner_id: string;
}

/**
 * The cross-partner correlation join, entirely in SQL: a corpus value+kind
 * held by an active/pending partner that is ALSO held by a different partner
 * whose status is not 'active' (suspended, churned, offboarding, or still
 * pending). Same-partner rows can never match (the join excludes
 * af1.partner_id = af2.partner_id), and a suspended<->suspended pair never
 * fires because af1's partner is restricted to active/pending.
 *
 * scannedPartnerIds is every active/pending partner holding ANY corpus row —
 * independent of whether it matched — so the caller can stale-resolve open
 * signals for partners that no longer hold matching fingerprints.
 */
export async function loadRecidivistMatches(): Promise<{
  matches: RecidivistMatch[];
  scannedPartnerIds: string[];
}> {
  const matchRows = (await db.execute(sql`
    SELECT
      af1.partner_id AS partner_id,
      af1.kind AS kind,
      af1.value AS value,
      af2.partner_id AS other_partner_id,
      p2.name AS other_partner_name,
      p2.status AS other_partner_status
    FROM abuse_endpoint_fingerprints af1
    JOIN partners p1 ON p1.id = af1.partner_id
    JOIN abuse_endpoint_fingerprints af2
      ON af2.kind = af1.kind
      AND af2.value = af1.value
      AND af2.partner_id != af1.partner_id
    JOIN partners p2 ON p2.id = af2.partner_id
    WHERE p1.status IN ('active', 'pending')
      AND p2.status != 'active'
  `)) as unknown as MatchRow[];

  const scannedRows = (await db.execute(sql`
    SELECT DISTINCT af.partner_id
    FROM abuse_endpoint_fingerprints af
    JOIN partners p ON p.id = af.partner_id
    WHERE p.status IN ('active', 'pending')
  `)) as unknown as ScannedPartnerRow[];

  const matches: RecidivistMatch[] = matchRows.map((r) => ({
    partnerId: r.partner_id,
    kind: r.kind,
    value: r.value,
    otherPartnerId: r.other_partner_id,
    otherPartnerName: r.other_partner_name,
    otherPartnerStatus: r.other_partner_status,
  }));

  return {
    matches,
    scannedPartnerIds: scannedRows.map((r) => r.partner_id),
  };
}

// ---------------------------------------------------------------------------
// Scorer (pure)
// ---------------------------------------------------------------------------

/** Evidence is capped to the first N matches per partner, same shape as the corroborating detectors' bounded evidence. */
const EVIDENCE_MATCH_CAP = 10;

type RecidivistAxis = 'fingerprint' | 'hostname_ip' | 'hostname';

/**
 * Pure scoring: no I/O, no clock, no partner age — takes only the raw
 * matches Task 2's SQL correlation produced. Unlike the other detectors in
 * this module, there is no youngWeight() call here at all, deliberately: a
 * re-established aged account matching a suspended partner's fingerprint is
 * MORE suspicious than a freshly-created one doing the same (it means the
 * operator sat on the reused hardware for a while before re-signing up), so
 * decaying the score down for account age would run backwards against what
 * the evidence means. Same structural argument as computeScriptSignals and
 * computeBillingIdentitySignals: the scorer's signature enforces this rather
 * than relying on a convention nobody checks.
 *
 * Per partner, three axes can fire (never summed — score is the MAX of
 * whichever axes matched, because a fingerprint match and a hostname match
 * against the same reused box are the same underlying event, not two
 * independent pieces of evidence):
 *   - fingerprint: any remote_tool_guid match, at any other partner.
 *   - hostname_ip: a hostname match AND an egress_ip match against the SAME
 *     other partner — the box kept both its hostname and its network egress,
 *     which is stronger than either alone.
 *   - hostname: a hostname match with no same-counterpart ip corroboration.
 *   - egress_ip alone never fires (v1): an IP is far weaker evidence on its
 *     own (NAT/ISP reuse, shared hosting ranges) — it only upgrades a
 *     hostname match to hostname_ip. ip_score is reserved and unemitted here.
 *
 * The direction rule (active-side only, non-active counterpart) is already
 * enforced by Task 2's SQL join — this function trusts its input and never
 * re-checks partner status.
 */
export function computeRecidivistSignals(matches: RecidivistMatch[], cfg: SignalConfig): ComputedSignal[] {
  const byPartner = new Map<string, RecidivistMatch[]>();
  for (const m of matches) {
    const list = byPartner.get(m.partnerId);
    if (list) list.push(m);
    else byPartner.set(m.partnerId, [m]);
  }

  const signals: ComputedSignal[] = [];

  for (const [partnerId, partnerMatches] of byPartner) {
    const hasFingerprint = partnerMatches.some((m) => m.kind === 'remote_tool_guid');
    const hostnameCounterparts = new Set(
      partnerMatches.filter((m) => m.kind === 'hostname').map((m) => m.otherPartnerId),
    );
    const ipCounterparts = new Set(
      partnerMatches.filter((m) => m.kind === 'egress_ip').map((m) => m.otherPartnerId),
    );
    const hasHostname = hostnameCounterparts.size > 0;
    // hostname_ip requires the SAME other-partner to hold both a hostname and
    // an egress_ip match — a hostname match against one counterpart plus an
    // ip match against an unrelated counterpart is two weaker, unrelated
    // pieces of evidence, not one stronger one.
    const hasHostnameIp = [...hostnameCounterparts].some((id) => ipCounterparts.has(id));

    const axes: RecidivistAxis[] = [];
    if (hasFingerprint) axes.push('fingerprint');
    if (hasHostnameIp) axes.push('hostname_ip');
    else if (hasHostname) axes.push('hostname');

    if (axes.length === 0) continue; // ip-only (or no match at all) — no signal in v1

    const axisScore: Record<RecidivistAxis, number> = {
      fingerprint: cfg['rmm.recidivist_endpoint.fingerprint_score'],
      hostname_ip: cfg['rmm.recidivist_endpoint.hostname_ip_score'],
      hostname: cfg['rmm.recidivist_endpoint.hostname_score'],
    };
    const score = Math.max(...axes.map((axis) => axisScore[axis]));

    signals.push({
      partnerId,
      signalKey: 'rmm.recidivist_endpoint',
      score,
      severity: scoreToSeverity(score, cfg),
      evidence: {
        axes,
        matches: partnerMatches.slice(0, EVIDENCE_MATCH_CAP).map((m) => ({
          kind: m.kind,
          value: m.value,
          otherPartnerName: m.otherPartnerName,
          otherPartnerStatus: m.otherPartnerStatus,
        })),
      },
    });
  }

  return signals;
}
