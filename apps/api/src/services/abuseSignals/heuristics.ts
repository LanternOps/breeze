import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { db } from '../../db';
import { scoreToSeverity, youngWeight, type SignalConfig } from './config';
import type { ComputedSignal } from './types';

export interface PartnerAggregates {
  partnerId: string;
  partnerName: string;
  partnerCreatedAt: Date;
  deviceCount: number;
  consumerHostnameCount: number;
  enrolled24h: number;
  distinctEnrollmentIps30d: number;
  devicesEnrolled30d: number;
  sessions7d: number;
  fastRemoteSessions7d: number;
  failedLogins24h: number;
  enrollmentDenied24h: number;
  commands24h: number;
  scriptExecutions24h: number;
  /** last_seen_ip of the partner's non-decommissioned devices (bounded per partner; nulls excluded). */
  lastSeenIps: string[];
}

// Default Windows hostnames (DESKTOP-XXXXXXX / LAPTOP-XXXXXXX) mark unmanaged
// consumer machines — a legit MSP's fleet is mostly named/domain-joined.
const CONSUMER_HOSTNAME_SQL = `d.hostname ~* '^(DESKTOP|LAPTOP)-[A-Z0-9]{7}$'`;

/**
 * One fleet-grouped pass over young-or-recently-active partners.
 * MUST run inside a system DB context — bare breeze_app reads return 0 rows.
 */
export async function loadPartnerAggregates(): Promise<PartnerAggregates[]> {
  const rows = (await db.execute(sql.raw(`
    WITH scoped AS (
      SELECT p.id, p.name, p.created_at
      FROM partners p
      WHERE p.deleted_at IS NULL AND p.status = 'active'
        AND (
          p.created_at > now() - interval '90 days'
          OR EXISTS (
            SELECT 1 FROM organizations o JOIN devices d ON d.org_id = o.id
            WHERE o.partner_id = p.id AND d.enrolled_at > now() - interval '2 hours'
          )
          -- Flagged partners keep being re-evaluated every sweep so open
          -- signals resolve on real evidence (score drops back below
          -- threshold), not merely because the partner aged out of the
          -- young/recently-enrolling scope — and per-row acknowledgments
          -- survive since the row is never stale-resolved out from under them.
          OR EXISTS (
            SELECT 1 FROM partner_abuse_signals pas
            WHERE pas.partner_id = p.id AND pas.resolved_at IS NULL
          )
        )
    ),
    dev AS (
      SELECT o.partner_id,
        COUNT(*) AS device_count,
        COUNT(*) FILTER (WHERE ${CONSUMER_HOSTNAME_SQL}) AS consumer_count,
        COUNT(*) FILTER (WHERE d.enrolled_at > now() - interval '24 hours') AS enrolled_24h,
        COUNT(DISTINCT d.enrollment_ip) FILTER (WHERE d.enrolled_at > now() - interval '30 days' AND d.enrollment_ip IS NOT NULL) AS distinct_enroll_ips_30d,
        COUNT(*) FILTER (WHERE d.enrolled_at > now() - interval '30 days' AND d.enrollment_ip IS NOT NULL) AS devices_enrolled_30d
      FROM devices d JOIN organizations o ON o.id = d.org_id
      WHERE d.status NOT IN ('decommissioned', 'quarantined')
      GROUP BY o.partner_id
    ),
    sess AS (
      SELECT o.partner_id,
        COUNT(*) AS sessions_7d,
        COUNT(*) FILTER (WHERE rs.created_at < d.enrolled_at + interval '24 hours') AS fast_remote_7d
      FROM remote_sessions rs
      JOIN devices d ON d.id = rs.device_id
      JOIN organizations o ON o.id = d.org_id
      WHERE rs.created_at > now() - interval '7 days'
      GROUP BY o.partner_id
    ),
    logins AS (
      -- Fresh partners have ONLY a partnerUsers link (createPartner never
      -- creates an organizationUsers row) — their partner-admin logins carry
      -- org_id NULL on audit_logs, so an org_id-only join never sees the
      -- failed logins for exactly the accounts this signal targets. Attribute
      -- across both axes: org-member failures via org_id -> organizations,
      -- and org_id-NULL failures via the audit row's actor_id -> users.id
      -- (actor_id is populated with the real users.id on every
      -- auditUserLoginFailure call site — apps/api/src/routes/auth/login.ts
      -- resolves the user row by email before auditing — so it's a more
      -- robust join key than actor_email, which isn't guaranteed unique/stable).
      SELECT pid AS partner_id, SUM(cnt) AS failed_24h FROM (
        -- org-attributable failed logins (org members)
        SELECT o.partner_id AS pid, COUNT(*) AS cnt
        FROM audit_logs al JOIN organizations o ON o.id = al.org_id
        WHERE al.action = 'user.login.failed' AND al."timestamp" > now() - interval '24 hours'
        GROUP BY o.partner_id
        UNION ALL
        -- partner-admin failed logins land with org_id NULL; attribute via
        -- the target user's partner_id (audit actor_id -> users.id)
        SELECT u.partner_id AS pid, COUNT(*) AS cnt
        FROM audit_logs al JOIN users u ON u.id = al.actor_id
        WHERE al.action = 'user.login.failed' AND al.org_id IS NULL
          AND al."timestamp" > now() - interval '24 hours' AND u.partner_id IS NOT NULL
        GROUP BY u.partner_id
      ) x GROUP BY pid
    ),
    denied AS (
      -- Counts org-attributable enrollment denials (expired/exhausted keys,
      -- secret mismatches on a resolved key, device-cap hits). Pre-key-
      -- resolution denials (unknown key, rate limit) have no org and are
      -- inherently unattributable to a partner.
      SELECT o.partner_id, COUNT(*) AS denied_24h
      FROM audit_logs al JOIN organizations o ON o.id = al.org_id
      WHERE al.action = 'agent.enroll' AND al.result = 'denied'
        AND al."timestamp" > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    cmds AS (
      SELECT o.partner_id, COUNT(*) AS commands_24h
      FROM device_commands dc
      JOIN devices d ON d.id = dc.device_id
      JOIN organizations o ON o.id = d.org_id
      WHERE dc.created_at > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    scripts AS (
      SELECT o.partner_id, COUNT(*) AS scripts_24h
      FROM script_executions se JOIN organizations o ON o.id = se.org_id
      WHERE se.created_at > now() - interval '24 hours'
      GROUP BY o.partner_id
    ),
    ips AS (
      -- Raw last-seen IPs per partner, bounded per partner. Prefix grouping
      -- (IPv4 /24, IPv6 /64 — incl. compressed-form canonicalization) happens
      -- in TS (ipPrefixGroup) where it is pure and unit-testable.
      SELECT partner_id, array_agg(ip) AS last_seen_ips
      FROM (
        SELECT o.partner_id, d.last_seen_ip AS ip,
          row_number() OVER (PARTITION BY o.partner_id ORDER BY d.id) AS rn
        FROM devices d JOIN organizations o ON o.id = d.org_id
        WHERE d.status NOT IN ('decommissioned', 'quarantined')
          AND d.last_seen_ip IS NOT NULL
      ) bounded
      WHERE rn <= 5000
      GROUP BY partner_id
    )
    SELECT s.id, s.name, s.created_at,
      COALESCE(dev.device_count, 0) AS device_count,
      COALESCE(dev.consumer_count, 0) AS consumer_count,
      COALESCE(dev.enrolled_24h, 0) AS enrolled_24h,
      COALESCE(dev.distinct_enroll_ips_30d, 0) AS distinct_enroll_ips_30d,
      COALESCE(dev.devices_enrolled_30d, 0) AS devices_enrolled_30d,
      COALESCE(sess.sessions_7d, 0) AS sessions_7d,
      COALESCE(sess.fast_remote_7d, 0) AS fast_remote_7d,
      COALESCE(logins.failed_24h, 0) AS failed_24h,
      COALESCE(denied.denied_24h, 0) AS denied_24h,
      COALESCE(cmds.commands_24h, 0) AS commands_24h,
      COALESCE(scripts.scripts_24h, 0) AS scripts_24h,
      COALESCE(ips.last_seen_ips, '{}') AS last_seen_ips
    FROM scoped s
    LEFT JOIN dev ON dev.partner_id = s.id
    LEFT JOIN sess ON sess.partner_id = s.id
    LEFT JOIN logins ON logins.partner_id = s.id
    LEFT JOIN denied ON denied.partner_id = s.id
    LEFT JOIN cmds ON cmds.partner_id = s.id
    LEFT JOIN scripts ON scripts.partner_id = s.id
    LEFT JOIN ips ON ips.partner_id = s.id
  `))) as unknown as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    partnerId: String(r.id),
    partnerName: String(r.name),
    partnerCreatedAt: new Date(String(r.created_at)),
    deviceCount: Number(r.device_count),
    consumerHostnameCount: Number(r.consumer_count),
    enrolled24h: Number(r.enrolled_24h),
    distinctEnrollmentIps30d: Number(r.distinct_enroll_ips_30d),
    devicesEnrolled30d: Number(r.devices_enrolled_30d),
    sessions7d: Number(r.sessions_7d),
    fastRemoteSessions7d: Number(r.fast_remote_7d),
    failedLogins24h: Number(r.failed_24h),
    enrollmentDenied24h: Number(r.denied_24h),
    commands24h: Number(r.commands_24h),
    scriptExecutions24h: Number(r.scripts_24h),
    lastSeenIps: Array.isArray(r.last_seen_ips) ? (r.last_seen_ips as unknown[]).map(String) : [],
  }));
}

/**
 * Canonical network-prefix bucket for an IP: IPv4 → /24, IPv6 → /64.
 *
 * Raw distinct addresses would misread legitimate fleets: a dual-stack office
 * hands every device a DIFFERENT IPv6 address inside one delegated /64, so
 * counting addresses instead of prefixes scores a single site as full
 * scatter. Compressed and expanded IPv6 forms (and mixed case / leading
 * zeros) canonicalize to the same bucket. IPv4-mapped IPv6 groups as the
 * embedded IPv4 /24. Returns null for unparseable input.
 */
export function ipPrefixGroup(raw: string): string | null {
  const ip = raw.trim();
  const version = isIP(ip);
  if (version === 4) {
    const [a, b, c] = ip.split('.');
    // isIP already guarantees four octets; the explicit check keeps the
    // undefined case out of the returned key rather than baking the string
    // "undefined" into a prefix bucket.
    if (a === undefined || b === undefined || c === undefined) return null;
    return `v4:${a}.${b}.${c}`;
  }
  if (version === 6) {
    // IPv4-mapped (::ffff:a.b.c.d) → bucket with the embedded IPv4 /24.
    const mappedV4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/i.exec(ip)?.[1];
    if (mappedV4 !== undefined) return `v4:${mappedV4}`;
    const hextets = expandIpv6(ip);
    if (!hextets) return null;
    return `v6:${hextets.slice(0, 4).join(':')}`;
  }
  return null;
}

/** Expand a (possibly ::-compressed) IPv6 address to 8 canonical hextets (lowercase, no leading zeros). */
function expandIpv6(ip: string): string[] | null {
  let s = ip;
  // Rewrite a trailing embedded IPv4 (e.g. `::ffff:0:1.2.3.4`) as two hextets.
  const embeddedV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s)?.[1];
  if (embeddedV4 !== undefined) {
    const [o0, o1, o2, o3] = embeddedV4.split('.').map(Number);
    if (o0 === undefined || o1 === undefined || o2 === undefined || o3 === undefined) return null;
    if ([o0, o1, o2, o3].some((o) => !Number.isInteger(o) || o > 255)) return null;
    const high = (((o0 << 8) | o1) >>> 0).toString(16);
    const low = (((o2 << 8) | o3) >>> 0).toString(16);
    s = `${s.slice(0, -embeddedV4.length)}${high}:${low}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : head.length !== 8) return null;
  const groups = [...head, ...(halves.length === 2 ? Array<string>(fill).fill('0') : []), ...tail];
  if (groups.length !== 8) return null;
  const canonical: string[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    canonical.push(parseInt(g, 16).toString(16));
  }
  return canonical;
}

/** Pure scoring: no I/O, unit-testable. Scores are 0-100 pre-weighting. */
export function computeHeuristicSignals(
  aggs: PartnerAggregates[],
  cfg: SignalConfig,
  now: Date,
): ComputedSignal[] {
  const signals: ComputedSignal[] = [];

  for (const a of aggs) {
    const weight = youngWeight(a.partnerCreatedAt, now, cfg);
    const push = (signalKey: string, rawScore: number, evidence: Record<string, unknown>, decays = true) => {
      const score = Math.min(100, Math.round(rawScore * (decays ? weight : 1)));
      if (!(score > 0)) return;
      signals.push({
        partnerId: a.partnerId,
        signalKey,
        score,
        severity: scoreToSeverity(score, cfg),
        evidence: { partnerName: a.partnerName, ...evidence },
      });
    };

    // rmm.consumer_devices — ratio of throwaway-named consumer machines.
    if (a.deviceCount >= cfg['rmm.consumer_devices.min_devices']) {
      const ratio = a.consumerHostnameCount / a.deviceCount;
      if (ratio >= cfg['rmm.consumer_devices.watch_ratio']) {
        push('rmm.consumer_devices', ratio * 100, {
          deviceCount: a.deviceCount,
          consumerHostnameCount: a.consumerHostnameCount,
          ratio: Number(ratio.toFixed(2)),
        });
      }
    }

    // rmm.enrollment_velocity — burst enrollments in 24h.
    const velThreshold = cfg['rmm.enrollment_velocity.devices_24h'];
    if (a.enrolled24h >= velThreshold) {
      push('rmm.enrollment_velocity', Math.min(100, (a.enrolled24h / velThreshold) * 50), {
        enrolled24h: a.enrolled24h,
      });
    }

    // rmm.session_intensity — fast enroll-to-remote is the scammer fingerprint.
    const fastThreshold = cfg['rmm.session_intensity.fast_remote_count_7d'];
    const perDeviceThreshold = cfg['rmm.session_intensity.sessions_per_device_7d'];
    const perDevice = a.deviceCount > 0 ? a.sessions7d / a.deviceCount : 0;
    if (a.fastRemoteSessions7d >= fastThreshold || perDevice >= perDeviceThreshold) {
      const fastScore = (a.fastRemoteSessions7d / fastThreshold) * 70;
      const volumeScore = (perDevice / perDeviceThreshold) * 40;
      push('rmm.session_intensity', Math.max(fastScore, volumeScore), {
        sessions7d: a.sessions7d,
        fastRemoteSessions7d: a.fastRemoteSessions7d,
        deviceCount: a.deviceCount,
      });
    }

    // rmm.enrollment_ip_spread — scattered origin IPs (residential-victim proxy until geo lands).
    if (a.devicesEnrolled30d >= cfg['rmm.enrollment_ip_spread.min_devices']) {
      const ratio = a.distinctEnrollmentIps30d / a.devicesEnrolled30d;
      if (ratio >= cfg['rmm.enrollment_ip_spread.distinct_ratio']) {
        push('rmm.enrollment_ip_spread', ratio * 80, {
          devicesEnrolled30d: a.devicesEnrolled30d,
          distinctEnrollmentIps30d: a.distinctEnrollmentIps30d,
        });
      }
    }

    // rmm.device_ip_scatter — every managed device on a different network is
    // the victim-fleet signature (one device per residential prefix); a real
    // client site has several devices behind one egress. Grouped by IPv4 /24
    // and IPv6 /64 — never raw addresses — so a dual-stack office's distinct
    // per-device IPv6 addresses inside one /64 don't read as scatter. Current
    // fleet shape is evidence independent of account age, so it never decays;
    // and it is weighted evidence, not proof (a small MSP managing remote/home
    // workers also scatters), so it caps at watch — always below
    // severity.alert_score — on its own.
    // An IP that doesn't parse is dropped from BOTH the numerator and the
    // denominator — it is a device we cannot place on a network, not a device
    // sharing a network. Counting it in the denominator only would dilute the
    // ratio toward "not scattered" and let a fleet hide behind junk values.
    const prefixes = new Set<string>();
    let devicesWithIp = 0;
    for (const ip of a.lastSeenIps) {
      const group = ipPrefixGroup(ip);
      if (group === null) continue;
      prefixes.add(group);
      devicesWithIp += 1;
    }
    if (devicesWithIp >= cfg['rmm.device_ip_scatter.min_devices']) {
      const scatterRatio = prefixes.size / devicesWithIp;
      if (scatterRatio >= cfg['rmm.device_ip_scatter.watch_ratio']) {
        push('rmm.device_ip_scatter', scatterRatio >= cfg['rmm.device_ip_scatter.high_ratio'] ? 55 : 45, {
          deviceCount: a.deviceCount,
          devicesWithIp,
          distinctPrefixes: prefixes.size,
          scatterRatio: Number(scatterRatio.toFixed(2)),
        }, false);
      }
    }

    // fraud.failed_login_cluster — never age-decayed.
    const loginThreshold = cfg['fraud.failed_login_cluster.count_24h'];
    if (a.failedLogins24h >= loginThreshold) {
      push('fraud.failed_login_cluster', Math.min(100, (a.failedLogins24h / loginThreshold) * 50), {
        failedLogins24h: a.failedLogins24h,
      }, false);
    }

    // resource.enrollment_denied — repeated cap/key rejections; never age-decayed.
    const deniedThreshold = cfg['resource.enrollment_denied.count_24h'];
    if (a.enrollmentDenied24h >= deniedThreshold) {
      push('resource.enrollment_denied', Math.min(100, (a.enrollmentDenied24h / deniedThreshold) * 50), {
        enrollmentDenied24h: a.enrollmentDenied24h,
      }, false);
    }

    // resource.volume_outlier — never age-decayed.
    const cmdThreshold = cfg['resource.volume_outlier.commands_24h'];
    const scriptThreshold = cfg['resource.volume_outlier.scripts_24h'];
    if (a.commands24h >= cmdThreshold || a.scriptExecutions24h >= scriptThreshold) {
      push('resource.volume_outlier', Math.min(
        100,
        Math.max((a.commands24h / cmdThreshold) * 50, (a.scriptExecutions24h / scriptThreshold) * 50),
      ), {
        commands24h: a.commands24h,
        scriptExecutions24h: a.scriptExecutions24h,
      }, false);
    }
  }

  return signals;
}
