import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  securityPostureOrgSnapshots,
  securityStatus,
} from '../../db/schema';
import { classifyDeviceProtection } from './protection';
import { getSecurityPostureTrend } from '../securityPosture';

function scoreBand(
  score: number,
): 'strong' | 'good' | 'fair' | 'at_risk' {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'at_risk';
}

export async function securityScoreTile(orgId: string, now: Date) {
  const [rows, trend] = await Promise.all([
    db
      .select({
        overallScore: securityPostureOrgSnapshots.overallScore,
        capturedAt: securityPostureOrgSnapshots.capturedAt,
      })
      .from(securityPostureOrgSnapshots)
      .where(eq(securityPostureOrgSnapshots.orgId, orgId))
      .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
      .limit(1),
    getSecurityPostureTrend({ orgId, days: 31 }),
  ]);

  const latest = rows[0];
  if (!latest) {
    return {
      status: 'no_data' as const,
      score: null,
      band: null,
      delta30d: null,
      capturedAt: null,
    };
  }

  const targetDay = new Date(
    now.getTime() - 30 * 86_400_000,
  ).toISOString().slice(0, 10);
  const prior = [...trend].sort((a, b) =>
    Math.abs(
      new Date(String(a.timestamp)).getTime() -
        new Date(targetDay).getTime(),
    ) -
    Math.abs(
      new Date(String(b.timestamp)).getTime() -
        new Date(targetDay).getTime(),
    ),
  )[0];

  return {
    status:
      now.getTime() - latest.capturedAt.getTime() > 86_400_000
        ? 'stale' as const
        : 'ok' as const,
    score: latest.overallScore,
    band: scoreBand(latest.overallScore),
    delta30d:
      typeof prior?.overall === 'number'
        ? latest.overallScore - prior.overall
        : null,
    capturedAt: latest.capturedAt.toISOString(),
  };
}

export async function devicesProtectedTile(orgId: string, now: Date) {
  const rows = await db
    .select({
      id: devices.id,
      realTimeProtection: securityStatus.realTimeProtection,
      provider: securityStatus.provider,
      hasS1Agent: sql<boolean>`exists (
        select 1 from s1_agents s1
        where s1.org_id = ${orgId}
          and s1.device_id = ${devices.id}
      )`,
      hasHuntressAgent: sql<boolean>`exists (
        select 1 from huntress_agents ha
        where ha.org_id = ${orgId}
          and ha.device_id = ${devices.id}
      )`,
    })
    .from(devices)
    .leftJoin(
      securityStatus,
      and(
        eq(securityStatus.deviceId, devices.id),
        eq(securityStatus.orgId, orgId),
      ),
    )
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
    .orderBy(asc(devices.id));

  if (rows.length === 0) {
    return {
      status: 'no_data' as const,
      protected: null,
      unprotected: null,
      unknown: null,
      total: null,
      asOf: now.toISOString(),
    };
  }

  const counts = { protected: 0, unprotected: 0, unknown: 0 };
  for (const row of rows) {
    counts[classifyDeviceProtection({
      securityStatus: row.provider
        ? {
            provider: row.provider!,
            realTimeProtection: row.realTimeProtection,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
    })] += 1;
  }

  return {
    status: 'ok' as const,
    ...counts,
    total: rows.length,
    asOf: now.toISOString(),
  };
}
