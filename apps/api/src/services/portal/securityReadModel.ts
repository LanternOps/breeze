import type {
  SecurityDeviceRow,
  SecurityDevicesDto,
  SecurityOverviewDto,
  ThreatSourceCounts,
} from '@breeze/shared';
import { and, asc, eq, gte, or, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  deviceVulnerabilities,
  huntressIncidents,
  securityStatus,
  securityThreats,
  s1Threats,
} from '../../db/schema';
import { prettySecurityProvider } from '../securityComplianceReportProducts';
import { getSecurityPostureTrend } from '../securityPosture';
import { classifyDeviceProtection } from './protection';
import { vulnerabilitySeverityForFindings } from './vulnerabilityCatalog';

// NOTE: W04 defines an identical scoreBand in this file; dedupe on merge.
function scoreBand(score: number): 'strong' | 'good' | 'fair' | 'at_risk' {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'at_risk';
}

// ---- W05 - security overview + devices ----
const WEEK_MS = 7 * 86_400_000;

const sourceCounts = (): ThreatSourceCounts => ({
  native: 0,
  sentinelOne: 0,
  huntress: 0,
});

function emptyWeeks(now: Date) {
  const first = new Date(now.getTime() - 8 * WEEK_MS);
  return Array.from({ length: 8 }, (_, index) => ({
    weekStart: new Date(first.getTime() + index * WEEK_MS)
      .toISOString().slice(0, 10),
    detected: 0,
    resolved: 0,
    detectedBySource: sourceCounts(),
    resolvedBySource: sourceCounts(),
  }));
}

export async function securityOverview(
  orgId: string,
  args: { days: number; timezone: string; now: Date },
): Promise<SecurityOverviewDto> {
  const days = Math.min(90, Math.max(1, args.days));
  const threatSince = new Date(args.now.getTime() - 8 * WEEK_MS);

  const [trend, nativeRows, s1Rows, huntressRows, findingRows] =
    await Promise.all([
      getSecurityPostureTrend({ orgId, days }),
      db.select({
        detectedAt: securityThreats.detectedAt,
        resolvedAt: securityThreats.resolvedAt,
      }).from(securityThreats).where(and(
        eq(securityThreats.orgId, orgId),
        or(
          gte(securityThreats.detectedAt, threatSince),
          gte(securityThreats.resolvedAt, threatSince),
        ),
      )),
      db.select({
        detectedAt: s1Threats.detectedAt,
        resolvedAt: s1Threats.resolvedAt,
      }).from(s1Threats).where(and(
        eq(s1Threats.orgId, orgId),
        or(
          gte(s1Threats.detectedAt, threatSince),
          gte(s1Threats.resolvedAt, threatSince),
        ),
      )),
      db.select({
        detectedAt: huntressIncidents.reportedAt,
        resolvedAt: huntressIncidents.resolvedAt,
      }).from(huntressIncidents).where(and(
        eq(huntressIncidents.orgId, orgId),
        or(
          gte(huntressIncidents.reportedAt, threatSince),
          gte(huntressIncidents.resolvedAt, threatSince),
        ),
      )),
      db.select({
        vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
        detectedAt: deviceVulnerabilities.detectedAt,
      }).from(deviceVulnerabilities).where(and(
        eq(deviceVulnerabilities.orgId, orgId),
        eq(deviceVulnerabilities.status, 'open'),
      )),
    ]);

  const scoreHistory = trend.map((point) => ({
    capturedAt: String(point.timestamp),
    score: Number(point.overall),
  }));
  const score = scoreHistory.at(-1)?.score ?? null;
  const weeks = emptyWeeks(args.now);
  const addEvents = (
    source: keyof ThreatSourceCounts,
    rows: Array<{ detectedAt: Date | null; resolvedAt: Date | null }>,
  ) => {
    for (const row of rows) {
      for (const [kind, value] of [
        ['detected', row.detectedAt],
        ['resolved', row.resolvedAt],
      ] as const) {
        if (!value) continue;
        const index = Math.floor(
          (value.getTime() - threatSince.getTime()) / WEEK_MS,
        );
        if (index < 0 || index > 7) continue;
        weeks[index]![kind] += 1;
        weeks[index]![kind === 'detected'
          ? 'detectedBySource'
          : 'resolvedBySource'][source] += 1;
      }
    }
  };
  addEvents('native', nativeRows);
  addEvents('sentinelOne', s1Rows);
  addEvents('huntress', huntressRows);

  let catalog = new Map<string, { severity: string; isKev: boolean }>();
  try {
    catalog = await vulnerabilitySeverityForFindings(
      [...new Set(findingRows.map((row) => row.vulnerabilityId))],
    );
  } catch {
    // The adapter maps unknown ids to `unknown`; this remains defensive for a
    // catalog outage so one gap cannot 500 the whole customer overview.
  }

  const openBySeverity: Record<string, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
  };
  let kevCount = 0;
  for (const finding of findingRows) {
    const item = catalog.get(finding.vulnerabilityId);
    const severity = item?.severity.toLowerCase() ?? 'unknown';
    const bucket = Object.hasOwn(openBySeverity, severity)
      ? severity
      : 'unknown';
    openBySeverity[bucket] = (openBySeverity[bucket] ?? 0) + 1;
    if (item?.isKev === true) kevCount += 1;
  }

  return {
    dataStatus:
      trend.length || nativeRows.length || s1Rows.length ||
      huntressRows.length || findingRows.length
        ? 'ok'
        : 'no_data',
    asOf: args.now.toISOString(),
    score,
    band: score == null ? null : scoreBand(score),
    scoreHistory,
    threatEvents: {
      label: 'endpoint threat events',
      weeks,
    },
    vulnerabilities: {
      openBySeverity,
      kevCount,
      lastDetectedAt: findingRows
        .map((row) => row.detectedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0]
        ?.toISOString() ?? null,
    },
  };
}

function avProductNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const product = item as Record<string, unknown>;
    const name = typeof product.displayName === 'string'
      ? product.displayName
      : typeof product.provider === 'string'
        ? prettySecurityProvider(product.provider)
        : null;
    return name?.trim() ? [name.trim()] : [];
  });
}

export async function securityDevicesPage(
  orgId: string,
  args: {
    page: number;
    limit: number;
    timezone: string;
    now: Date;
  },
): Promise<SecurityDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const hasS1Agent = sql<boolean>`exists (
    select 1 from s1_agents s1
    where s1.org_id = ${orgId} and s1.device_id = ${devices.id}
  )`;
  const hasHuntressAgent = sql<boolean>`exists (
    select 1 from huntress_agents ha
    where ha.org_id = ${orgId} and ha.device_id = ${devices.id}
  )`;
  const protectionOrder = sql`case
    when ${hasS1Agent} or ${hasHuntressAgent} then 'protected'
    when ${securityStatus.id} is null then 'unknown'
    when ${securityStatus.provider} <> 'other'
      and ${securityStatus.realTimeProtection} = true then 'protected'
    else 'unprotected'
  end`;

  const [countRows, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.isEphemeral, false),
      )),
    db.select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      provider: securityStatus.provider,
      avProducts: securityStatus.avProducts,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      encryptionStatus: securityStatus.encryptionStatus,
      firewallEnabled: securityStatus.firewallEnabled,
      securityUpdatedAt: securityStatus.updatedAt,
      hasS1Agent,
      hasHuntressAgent,
      pendingCriticalPatches: sql<number>`(
        select count(*)::int
        from device_patches dp
        join patches p on p.id = dp.patch_id
        where dp.org_id = ${orgId}
          and dp.device_id = ${devices.id}
          and dp.status = 'pending'
          and p.severity = 'critical'
      )`,
    })
      .from(devices)
      .leftJoin(securityStatus, and(
        eq(securityStatus.deviceId, devices.id),
        eq(securityStatus.orgId, orgId),
      ))
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.isEphemeral, false),
      ))
      .orderBy(
        sql`case ${protectionOrder}
          when 'protected' then 1
          else 0 end`,
        asc(sql`coalesce(${devices.displayName}, ${devices.hostname})`),
        asc(devices.id),
      )
      .limit(args.limit)
      .offset(offset),
  ]);

  const data: SecurityDeviceRow[] = rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.hostname,
    protection: classifyDeviceProtection({
      securityStatus: row.provider
        ? {
            provider: row.provider,
            realTimeProtection: row.realTimeProtection,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
    }),
    avProducts: [...new Set([
      ...(row.hasS1Agent ? ['SentinelOne'] : []),
      ...(row.hasHuntressAgent ? ['Huntress'] : []),
      ...avProductNames(row.avProducts),
      ...(row.provider && row.provider !== 'other'
        ? [prettySecurityProvider(row.provider)]
        : []),
    ])],
    realTimeProtection: row.realTimeProtection,
    definitionsAgeDays: row.definitionsDate
      ? Math.floor(
          (args.now.getTime() - row.definitionsDate.getTime()) / 86_400_000,
        )
      : null,
    encryption: row.securityUpdatedAt ? row.encryptionStatus : null,
    firewall: row.securityUpdatedAt ? row.firewallEnabled : null,
    pendingCriticalPatches: Number(row.pendingCriticalPatches ?? 0),
    observedAt: row.securityUpdatedAt?.toISOString() ?? null,
  }));
  const total = Number(countRows[0]?.count ?? 0);

  return {
    dataStatus: total > 0 ? 'ok' : 'no_data',
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total,
    },
  };
}

// W05 - security overview + devices
