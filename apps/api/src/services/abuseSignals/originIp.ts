import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { scoreToSeverity, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

/**
 * Origin-IP recidivism.
 *
 * The signup gate's `stage1.suspended_ip_match` reads ONE address: the IP the
 * registration request arrived from. That was enough while operators signed up
 * straight from their own infrastructure. It no longer is — the observed shape
 * is now:
 *
 *   1. probe the suspended account (a failed login) from ring infrastructure,
 *   2. sign up the replacement from a clean residential address,
 *   3. only then work the new account from the ring address again.
 *
 * Step 2 is what the signup gate sees, and it is clean by construction. The
 * evidence lives in steps 1 and 3, both of which are console activity that
 * nothing scored until this detector.
 *
 * Two signals, deliberately of different strengths:
 *
 *  - `fraud.suspended_console_ip` — an EXACT address shared with a suspended
 *    partner. Scored to reach alert on a single match, matching the confidence
 *    the signup gate already assigns to an exact signup-IP match (which has a
 *    perfect record: every hold it ever placed was a true positive).
 *
 *  - `fraud.dead_account_probe_origin` — the partner works from the same /24
 *    (or IPv6 /64) that someone recently probed a SUSPENDED partner's login
 *    from. A network is a weaker tie than an address, so this caps below alert
 *    and corroborates instead. Its looseness is bounded on two sides: the
 *    counterparty must be a failed login against an already-suspended account,
 *    and it must be recent.
 *
 * Neither is age-decayed. Sibling rule to the billing-identity and
 * script-content detectors: an address shared with a suspended operator is
 * evidence about infrastructure, not about how old the account is — and
 * pre-positioned accounts sit dormant for weeks precisely to age out of
 * young-account weighting.
 */

export const SUSPENDED_CONSOLE_IP_KEY = 'fraud.suspended_console_ip';
export const DEAD_ACCOUNT_PROBE_KEY = 'fraud.dead_account_probe_origin';

export interface PartnerOriginAggregate {
  partnerId: string;
  partnerName: string;
  partnerStatus: 'active' | 'pending';
  /** Distinct addresses this partner has been seen at: signup_ip plus every audit `ip_address` for its users. */
  originIps: string[];
}

export interface DeadAccountProbe {
  ip: string;
  /** The suspended partner whose login was probed. */
  partnerName: string;
  at: Date;
}

export interface OriginIpCorpus {
  /** Exact address -> names of the suspended partners seen at it. */
  suspendedIps: Map<string, string[]>;
  probes: DeadAccountProbe[];
}

export interface OriginIpResult {
  aggregates: PartnerOriginAggregate[];
  corpus: OriginIpCorpus;
  /** Partners this detector actually evaluated, for stale-resolution in persistSignals. */
  scannedPartnerIds: string[];
}

/**
 * Pull the client address out of whatever `audit_logs.ip_address` holds.
 *
 * That column is a varchar and production holds three shapes: a bare address,
 * the literal string `unknown` (rows written before the field was populated),
 * and — on older rows — an unreduced `X-Forwarded-For` chain such as
 * `"198.51.100.9, 172.19.0.8"`, where the second hop is the container-internal
 * proxy address. The leftmost entry is the client, which is the one that
 * identifies the operator; taking the whole string instead would parse as
 * nothing and silently drop the row's origin entirely.
 */
function clientIp(raw: string): string {
  const first = raw.split(',')[0] ?? '';
  return first.trim();
}

/**
 * Collapse an address to the network we treat as "the same place": /24 for
 * IPv4, /64 for IPv6 (the smallest unit routinely assigned to one customer).
 *
 * Returns null for anything that is not an address — `unknown` and other junk
 * must never match each other, or every legacy row would correlate with every
 * other one.
 */
export function networkPrefix(raw: string): string | null {
  const ip = clientIp(raw);
  const version = isIP(ip);
  if (version === 4) {
    const octets = ip.split('.');
    return `v4:${octets[0]}.${octets[1]}.${octets[2]}`;
  }
  if (version === 6) {
    const groups = expandIPv6(ip);
    if (!groups) return null;
    return `v6:${groups.slice(0, 4).join(':')}`;
  }
  return null;
}

/**
 * Expand an IPv6 literal to its eight zero-padded groups.
 *
 * Written out rather than compared as strings because the same /64 arrives in
 * both forms — `2001:db8:145:2002::1` from one request and
 * `2001:db8:0145:2002:64d5:59e4:bb86:ce4d` from the next — and a textual
 * prefix comparison would read those as two unrelated networks, which is
 * exactly the hop this detector exists to catch.
 */
function expandIPv6(ip: string): string[] | null {
  // An embedded IPv4 tail (::ffff:203.0.113.7) contributes two groups.
  const v4Tail = ip.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  let work = ip;
  if (v4Tail) {
    const octets = v4Tail[1]!.split('.').map(Number);
    if (octets.some((o) => !Number.isInteger(o) || o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    work = `${ip.slice(0, ip.length - v4Tail[1]!.length)}${hi}:${lo}`;
  }

  const halves = work.split('::');
  if (halves.length > 2) return null;
  const parse = (segment: string): string[] | null => {
    if (segment === '') return [];
    const out: string[] = [];
    for (const group of segment.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(group.toLowerCase().padStart(4, '0'));
    }
    return out;
  };

  const head = parse(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parse(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  return [...head, ...Array<string>(fill).fill('0000'), ...tail];
}

/** Normalize for exact comparison: IPv6 compression must not defeat an exact match. */
function canonical(raw: string): string | null {
  const ip = clientIp(raw);
  const version = isIP(ip);
  if (version === 4) return `v4:${ip}`;
  if (version === 6) {
    const groups = expandIPv6(ip);
    return groups ? `v6:${groups.join(':')}` : null;
  }
  return null;
}

/**
 * Pure — no I/O.
 *
 * Note what is deliberately absent: any cap on how many suspended partners may
 * share an address. The signup gate shipped exactly that guard and it silenced
 * the check the moment an IP reached its third suspended account — on the
 * theory that a busy address must be shared egress. In production every capped
 * address turned out to be ring infrastructure and the guard never once
 * prevented a false positive; it only ever hid the third, fourth and fifth
 * account of a ring that had already been proven. More suspended neighbours
 * make this signal stronger, never quieter.
 */
export function computeOriginIpSignals(
  aggregates: PartnerOriginAggregate[],
  corpus: OriginIpCorpus,
  cfg: SignalConfig,
  now: Date,
): ComputedSignal[] {
  const base = cfg['fraud.suspended_console_ip.base_score'];
  const perExtra = cfg['fraud.suspended_console_ip.per_extra_ip'];
  const probeScore = cfg['fraud.dead_account_probe_origin.score'];
  const windowMs = cfg['fraud.dead_account_probe_origin.window_hours'] * 3_600_000;

  // Exact-match index, keyed canonically so a compressed IPv6 literal on one
  // side and an expanded one on the other still meet.
  const suspendedByCanonical = new Map<string, string[]>();
  for (const [ip, names] of corpus.suspendedIps) {
    const key = canonical(ip);
    if (!key) continue;
    const existing = suspendedByCanonical.get(key);
    if (existing) existing.push(...names);
    else suspendedByCanonical.set(key, [...names]);
  }

  const probesByPrefix = new Map<string, DeadAccountProbe[]>();
  for (const probe of corpus.probes) {
    if (now.getTime() - probe.at.getTime() > windowMs) continue;
    // A probe timestamped in the future is clock skew, not evidence.
    if (probe.at.getTime() > now.getTime()) continue;
    const prefix = networkPrefix(probe.ip);
    if (!prefix) continue;
    const existing = probesByPrefix.get(prefix);
    if (existing) existing.push(probe);
    else probesByPrefix.set(prefix, [probe]);
  }

  const out: ComputedSignal[] = [];
  for (const partner of aggregates) {
    const matchedIps: string[] = [];
    const seenMatchKeys = new Set<string>();
    const suspendedPartners: string[] = [];
    const seenSuspended = new Set<string>();

    for (const ip of partner.originIps) {
      const key = canonical(ip);
      if (!key || seenMatchKeys.has(key)) continue;
      const names = suspendedByCanonical.get(key);
      if (!names) continue;
      // Dedup on the canonical key and cite the bare client address: two
      // surface forms of one address (compressed vs expanded IPv6, or two XFF
      // chains) are one match, and the evidence line must be a clean IP an
      // on-call analyst can grep infra records for.
      seenMatchKeys.add(key);
      matchedIps.push(clientIp(ip));
      for (const name of names) {
        if (seenSuspended.has(name)) continue;
        seenSuspended.add(name);
        suspendedPartners.push(name);
      }
    }

    if (matchedIps.length > 0) {
      const score = Math.min(100, Math.round(base + perExtra * (matchedIps.length - 1)));
      out.push({
        partnerId: partner.partnerId,
        signalKey: SUSPENDED_CONSOLE_IP_KEY,
        score,
        severity: scoreToSeverity(score, cfg),
        // Key order matters: index.ts truncates serialised evidence at 800
        // chars, so the human-readable identifiers lead.
        evidence: {
          partnerName: partner.partnerName,
          partnerStatus: partner.partnerStatus,
          matchedIps,
          suspendedPartners,
        },
      });
      // The exact match strictly dominates a /24 match and the two share a
      // corroboration axis, so a second row could never change an outcome.
      continue;
    }

    const probedPartners: string[] = [];
    const matchedPrefixes: string[] = [];
    const seenProbed = new Set<string>();
    for (const ip of partner.originIps) {
      const prefix = networkPrefix(ip);
      if (!prefix) continue;
      const probes = probesByPrefix.get(prefix);
      if (!probes) continue;
      if (!matchedPrefixes.includes(prefix)) matchedPrefixes.push(prefix);
      for (const probe of probes) {
        if (seenProbed.has(probe.partnerName)) continue;
        seenProbed.add(probe.partnerName);
        probedPartners.push(probe.partnerName);
      }
    }

    if (probedPartners.length === 0) continue;
    out.push({
      partnerId: partner.partnerId,
      signalKey: DEAD_ACCOUNT_PROBE_KEY,
      score: probeScore,
      severity: scoreToSeverity(probeScore, cfg),
      evidence: {
        partnerName: partner.partnerName,
        partnerStatus: partner.partnerStatus,
        probedPartners,
        matchedNetworks: matchedPrefixes,
      },
    });
  }
  return out;
}

/**
 * Every audit lookup below reaches `audit_logs` through
 * `audit_logs_actor_email_timestamp_idx` — the ONLY selective index that table
 * has. It carries ~5M rows / 4GB in production with no index on `action`,
 * `actor_id`, `ip_address` or `timestamp` alone, so any predicate that starts
 * from one of those is a full sequential scan.
 *
 * Three shape rules, each measured against the production US database
 * (the larger of the two regions) because each earlier draft was too slow:
 *
 *  1. **Bound every audit read by `timestamp`.** Leaving the suspended-partner
 *     corpus unbounded cost 15s and returned byte-identical rows to a 365-day
 *     bound at 0.4s: suspended accounts stop generating audit rows when they
 *     are suspended, so the unbounded tail is empty by construction.
 *
 *  2. **Never put `action` in a predicate that has to stand on its own.**
 *     Filtering `action = 'user.login.failed'` as a separate CTE made the
 *     planner abandon the email index and the query timed out at 180s. It is
 *     applied here as a FILTER clause on an aggregate that is already reading
 *     the rows for another reason.
 *
 *  3. **Aggregate INSIDE the single read.** Materialising raw audit rows and
 *     grouping them afterwards cost 45s; grouping to `(name, ip)` inside the
 *     CTE — ~220 rows out of it — costs 2.1s cold and 144ms warm.
 *
 * If you extend this query, keep `actor_email` as the entry point and re-time
 * it against the larger region rather than trusting a local dataset.
 */
export async function loadOriginIpAggregates(): Promise<OriginIpResult> {
  const rows = (await db.execute(sql`
    WITH scoped AS (
      SELECT p.id, p.name, p.status, p.signup_ip
      FROM partners p
      -- 'pending' is in scope for the same reason billingIdentity includes it:
      -- a pre-positioned account never activates, so an active-only detector
      -- is blind to the entire shape this one exists to catch.
      --
      -- Deliberately NO age gate on this population, unlike heuristics.ts's
      -- scoped CTE. There the 90-day cutoff mirrors the scorer's own age decay
      -- (youngWeight() reaches zero at young_zero_weight_days), so excluding
      -- old partners from the query matches what the scorer would do anyway.
      -- THIS scorer has no age decay at all — a 120-day-old account that
      -- starts working the console from a newly-suspended operator's address
      -- must be scannable the first time that correlation exists, and an age
      -- gate here would exclude exactly that partner (it cannot yet have an
      -- open row from this detector to re-admit it). The cost of the wider
      -- population is bounded elsewhere: the audit arm of scoped_ips is
      -- timestamp-bounded to 90 days, so a dormant partner contributes only
      -- its signup_ip row. Per the header rule, re-time against the larger
      -- region before narrowing this again.
      WHERE p.deleted_at IS NULL AND p.status IN ('active', 'pending')
    ),
    -- No bound on how long ago the partner was SUSPENDED, on purpose: an
    -- operator who returns four months later is exactly who this is for. The
    -- 365-day bound below is on how far back we read their audit history,
    -- which is a different thing — a suspended account stops producing rows.
    suspended AS MATERIALIZED (
      SELECT p.id, p.name, p.signup_ip
      FROM partners p
      WHERE p.deleted_at IS NULL AND p.status = 'suspended'
    ),
    -- ONE pass over the suspended operators' audit history, aggregated in
    -- place to ~200 rows. last_failed_at doubles as the probe detector: a
    -- failed login against a user who belongs to an ALREADY-SUSPENDED partner
    -- is the operator rattling the handle on the dead account, and on every
    -- case on record it precedes the replacement signup. See rules 2 and 3 in
    -- the header before touching the FILTER.
    susp_audit AS MATERIALIZED (
      SELECT sp.name, al.ip_address AS ip,
        max(al."timestamp") FILTER (
          WHERE al.action = 'user.login.failed' AND al."timestamp" > now() - interval '30 days'
        ) AS last_failed_at
      FROM suspended sp
      JOIN users u ON u.partner_id = sp.id
      JOIN audit_logs al ON al.actor_email = u.email
      WHERE al."timestamp" > now() - interval '365 days'
        AND al.ip_address IS NOT NULL AND al.ip_address <> 'unknown'
      GROUP BY sp.name, al.ip_address
    ),
    scoped_ips AS (
      SELECT s.id AS partner_id, s.name, s.status::text AS status, host(s.signup_ip::inet) AS ip
      FROM scoped s WHERE s.signup_ip IS NOT NULL
      UNION
      SELECT s.id, s.name, s.status::text, al.ip_address
      FROM scoped s
      JOIN users u ON u.partner_id = s.id
      JOIN audit_logs al ON al.actor_email = u.email
      WHERE al."timestamp" > now() - interval '90 days'
        AND al.ip_address IS NOT NULL AND al.ip_address <> 'unknown'
    ),
    suspended_ip_list AS (
      SELECT sp.name, host(sp.signup_ip::inet) AS ip
      FROM suspended sp WHERE sp.signup_ip IS NOT NULL
      UNION
      SELECT name, ip FROM susp_audit
    ),
    probe_list AS (
      SELECT name, ip, last_failed_at AS at FROM susp_audit WHERE last_failed_at IS NOT NULL
    )
    SELECT 'scoped' AS kind, partner_id::text AS partner_id, name, status, ip, NULL::timestamptz AS at FROM scoped_ips
    UNION ALL
    SELECT 'suspended', NULL, name, NULL, ip, NULL FROM suspended_ip_list
    UNION ALL
    SELECT 'probe', NULL, name, NULL, ip, at FROM probe_list
  `)) as unknown as Array<{
    kind: 'scoped' | 'suspended' | 'probe';
    partner_id: string | null;
    name: string;
    status: string | null;
    ip: string;
    at: Date | string | null;
  }>;

  const byPartner = new Map<string, PartnerOriginAggregate>();
  const suspendedIps = new Map<string, string[]>();
  const probes: DeadAccountProbe[] = [];

  for (const row of rows) {
    if (row.kind === 'scoped') {
      if (!row.partner_id) continue;
      let agg = byPartner.get(row.partner_id);
      if (!agg) {
        agg = {
          partnerId: row.partner_id,
          partnerName: row.name,
          partnerStatus: row.status === 'pending' ? 'pending' : 'active',
          originIps: [],
        };
        byPartner.set(row.partner_id, agg);
      }
      // Normalize before dedup: the same client logged through two different
      // legacy XFF second hops ("1.2.3.4, 10.0.0.1" vs "1.2.3.4, 10.0.0.5")
      // must collapse to one origin, or the per_extra_ip bonus counts one real
      // address twice and the evidence body shows garbled chain strings.
      const ip = clientIp(row.ip);
      if (ip && !agg.originIps.includes(ip)) agg.originIps.push(ip);
    } else if (row.kind === 'suspended') {
      const names = suspendedIps.get(row.ip);
      if (names) {
        if (!names.includes(row.name)) names.push(row.name);
      } else {
        suspendedIps.set(row.ip, [row.name]);
      }
    } else if (row.at) {
      probes.push({ ip: row.ip, partnerName: row.name, at: new Date(row.at) });
    }
  }

  const aggregates = [...byPartner.values()];
  return { aggregates, corpus: { suspendedIps, probes }, scannedPartnerIds: aggregates.map((a) => a.partnerId) };
}
