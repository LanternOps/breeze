/**
 * Device activity feed — RLS index promotability contract (2026-09-03 US incident).
 *
 * What only a real Postgres, as the unprivileged `breeze_app` role, can prove:
 * under forced RLS the planner promotes a clause to an index condition only when
 * it is leakproof. The old one-query feed, `(resource_id = X OR
 * details->>'deviceId' = X)`, contains jsonb_object_field_text (not leakproof)
 * and so could only ever use audit_logs_org_timestamp_idx — a walk of the org's
 * whole audit history per device page load (2.4M rows, 13-minute queries and
 * connection-slot exhaustion on the US managed DB).
 *
 * The route now issues two arms (routes/devices/events.ts). This suite asserts,
 * with EXPLAIN as breeze_app inside an org-scoped access context and seq scans
 * disabled, that:
 *   1. the deliberate-action resource arm is served by the partial index
 *      audit_logs_device_feed_resource_idx (predicate `actor_type <> 'agent'`);
 *   2. the details arm is served by audit_logs_device_feed_details_idx
 *      (predicate `actor_type <> 'agent' AND details ? 'deviceId'`);
 *   3. the unfiltered resource arm is served by an index keyed on resource_id.
 * With enable_seqscan off, any usable index beats a seq scan by ~1e10 cost, so
 * a seq scan in the plan means the clause is NOT promotable under RLS — exactly
 * the regression this guards against. It also proves the functional contract
 * that the two arms together still return the details-only rows
 * (device.command.queue) while the deliberate feed drops agent telemetry.
 */
import './setup';

import { describe, it, expect, beforeEach } from 'vitest';
import { and, eq, or, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db, withDbAccessContext } from '../../db';
import { getTestDb } from './setup';
import { auditLogs } from '../../db/schema';
import { DETAILS_HAS_DEVICE_ID, NON_AGENT_ACTOR, buildActionConditions } from '../../routes/devices/events';
import { createPartner, createOrganization } from './db-utils';

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

function planText(rows: unknown[]): string {
  return rows.map((r) => Object.values(r as Record<string, unknown>).join(' ')).join('\n');
}

describe('device events feed — partial indexes are usable under RLS (breeze_app)', () => {
  let orgId: string;
  let deviceId: string;
  let commandId: string;

  // beforeEach, not beforeAll: the harness TRUNCATEs on every test (audit_logs
  // included, via the organizations cascade).
  beforeEach(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    deviceId = randomUUID();
    commandId = randomUUID();

    // Enough rows that the planner's choice is not a coin toss on a tiny
    // table: the org index sees ~3,800 rows, the device's resource index ~600,
    // the actor-partial resource index ~200, the details index 1. (Production
    // is far more skewed still.)
    const telemetry = (targetDevice: string) => ({
      orgId,
      actorType: 'agent' as const,
      actorId: targetDevice,
      action: 'agent.logs.submit',
      resourceType: 'device',
      resourceId: targetDevice,
      result: 'success' as const,
    });
    const otherDevices = Array.from({ length: 30 }, () => randomUUID());
    const otherDevice = (i: number) => otherDevices[i % otherDevices.length] as string;
    // Non-agent rows on other devices, with no deviceId in details: they sit in
    // the actor-partial resource index but not in the details index, so the
    // details arm has a reason to prefer its own index.
    const humanNoise = (i: number) => ({
      orgId,
      actorType: 'user' as const,
      actorId: randomUUID(),
      action: 'device.settings.update',
      resourceType: 'device',
      resourceId: otherDevice(i),
      details: { field: 'displayName' },
      result: 'success' as const,
    });
    await getTestDb()
      .insert(auditLogs)
      .values([
        ...Array.from({ length: 600 }, () => telemetry(deviceId)),
        ...Array.from({ length: 3000 }, (_, i) => telemetry(otherDevice(i))),
        ...Array.from({ length: 200 }, (_, i) => humanNoise(i)),
      ]);

    await getTestDb()
      .insert(auditLogs)
      .values([
        // Deliberate route audit: resource = device.
        {
          orgId,
          actorType: 'user',
          actorId: randomUUID(),
          action: 'script.execute',
          resourceType: 'device',
          resourceId: deviceId,
          result: 'success',
        },
        // Details-only linkage: resource = the queued command, device in details.
        {
          orgId,
          actorType: 'user',
          actorId: randomUUID(),
          action: 'device.command.queue',
          resourceType: 'device_command',
          resourceId: commandId,
          details: { deviceId, type: 'reboot' },
          result: 'success',
        },
        // Automated dispatch: system actor, resource = device.
        {
          orgId,
          actorType: 'system',
          actorId: SYSTEM_ACTOR,
          action: 'agent.command.install_patches',
          resourceType: 'device',
          resourceId: deviceId,
          result: 'success',
        },
      ]);
    await getTestDb().execute(sql`ANALYZE audit_logs`);
  });

  function inOrgContext<T>(fn: () => Promise<T>): Promise<T> {
    return withDbAccessContext(
      { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [] },
      fn
    );
  }

  const deliberate = () => or(...buildActionConditions(['script.', 'device.command'], true))!;

  const resourceArm = (withActorGuard: boolean) =>
    and(
      eq(auditLogs.orgId, orgId),
      ...(withActorGuard ? [deliberate()] : []),
      eq(auditLogs.resourceId, deviceId),
      ...(withActorGuard ? [NON_AGENT_ACTOR] : [])
    )!;

  const detailsArm = () =>
    and(
      eq(auditLogs.orgId, orgId),
      deliberate(),
      NON_AGENT_ACTOR,
      DETAILS_HAS_DEVICE_ID,
      sql`${auditLogs.details}->>'deviceId' = ${deviceId}`,
      sql`${auditLogs.resourceId} IS DISTINCT FROM ${deviceId}::uuid`
    )!;

  async function explain(where: ReturnType<typeof and>): Promise<string> {
    return inOrgContext(async () => {
      await db.execute(sql`SET LOCAL enable_seqscan = off`);
      const q = db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(where)
        .orderBy(sql`${auditLogs.timestamp} DESC, ${auditLogs.id} DESC`)
        .limit(10);
      const rows = await db.execute(sql`EXPLAIN ${q.getSQL()}`);
      return planText(Array.from(rows as Iterable<unknown>));
    });
  }

  it('deliberate resource arm uses the actor-partial index, not a scan of the org', async () => {
    const plan = await explain(resourceArm(true));
    expect(plan).toContain('audit_logs_device_feed_resource_idx');
    expect(plan).not.toContain('Seq Scan on audit_logs');
    expect(plan).not.toContain('audit_logs_org_timestamp_idx');
  });

  it('details arm uses the details-partial org index', async () => {
    const plan = await explain(detailsArm());
    expect(plan).toContain('audit_logs_device_feed_details_idx');
    expect(plan).not.toContain('Seq Scan on audit_logs');
  });

  it('unfiltered resource arm (Activities tab) is served by a resource_id index', async () => {
    const plan = await explain(resourceArm(false));
    expect(plan).toMatch(/audit_logs_resource_(type_)?id_timestamp_idx/);
    expect(plan).not.toContain('Seq Scan on audit_logs');
  });

  it('the two arms together return the details-only row and drop agent telemetry', async () => {
    const keys = await inOrgContext(async () => {
      const [a, b] = await Promise.all([
        db.select({ action: auditLogs.action }).from(auditLogs).where(resourceArm(true)),
        db.select({ action: auditLogs.action }).from(auditLogs).where(detailsArm()),
      ]);
      return [...a, ...b].map((r) => r.action).sort();
    });
    expect(keys).toEqual(['agent.command.install_patches', 'device.command.queue', 'script.execute']);
  });

  it('the unfiltered resource arm still includes agent rows', async () => {
    const keys = await inOrgContext(async () => {
      const rows = await db.select({ action: auditLogs.action }).from(auditLogs).where(resourceArm(false));
      return rows.map((r) => r.action).sort();
    });
    expect(new Set(keys)).toEqual(new Set(['agent.command.install_patches', 'agent.logs.submit', 'script.execute']));
    expect(keys.filter((k) => k === 'agent.logs.submit')).toHaveLength(600);
  });
});
