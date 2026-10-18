/**
 * Integration test — device change ingest against real Postgres + RLS.
 *
 * Phase 2 of #2502: `device_change_log.change_type` is a Postgres enum
 * (`ALTER TYPE change_type ADD VALUE ...` in
 * `migrations/0026-device-change-log.sql` + `2026-07-14-change-log-hardware-os-enum.sql`).
 * A pg enum constraint can only be validated against a real database — the
 * mocked unit suite (`changes.test.ts`) stubs `../../db` entirely and would
 * happily "accept" a bogus changeType the real enum would reject with a
 * Postgres error. This suite drives the actual `changesRoutes` handler
 * against the test DB as the unprivileged `breeze_app` role, under the same
 * `withDbAccessContext` shape `agentAuthMiddleware` sets up for every
 * non-self-managed agent route (see `middleware/agentAuth.ts:455-469`), so
 * the `device_change_log` RLS insert/select policies
 * (`breeze_has_org_access(org_id)`) are exercised for real rather than
 * bypassed.
 */
import '../../__tests__/integration/setup';
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { devices, deviceChangeLog } from '../../db/schema';
import { setupTestEnvironment } from '../../__tests__/integration/db-utils';
import { changesRoutes } from './changes';

const runDb = it.runIf(!!process.env.DATABASE_URL);

/** The exact RLS context `agentAuthMiddleware` sets up for org-scoped agent routes. */
function agentRequestContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

async function insertDevice(orgId: string, siteId: string): Promise<{ id: string; agentId: string }> {
  const agentId = `agent-changes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return withSystemDbAccessContext(async () => {
    const [row] = await db
      .insert(devices)
      .values({
        orgId,
        siteId,
        agentId,
        hostname: `changes-${agentId}`,
        osType: 'windows',
        osVersion: '11',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
        enrolledAt: new Date(),
      })
      .returning({ id: devices.id });
    if (!row) throw new Error('insertDevice: no row');
    return { id: row.id, agentId };
  });
}

/** Submits a change batch through the real Hono handler, under the same
 * withDbAccessContext wrap agentAuthMiddleware applies in production. */
async function submitChanges(orgId: string, agentId: string, changes: unknown[]) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', { orgId, agentId, role: 'agent' } as never);
    await next();
  });
  app.route('/agents', changesRoutes);
  return withDbAccessContext(agentRequestContext(orgId), async () =>
    app.request(`/agents/${agentId}/changes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    })
  );
}

describe('device change ingest — hardware & os_version (real Postgres, #2502 Phase 2)', () => {
  runDb('accepts hardware and os_version change types and persists them', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);

    const res = await submitChanges(env.organization.id, dev.agentId, [
      {
        timestamp: new Date().toISOString(),
        changeType: 'hardware',
        changeAction: 'modified',
        subject: 'Memory',
        beforeValue: { value: '4 GB' },
        afterValue: { value: '8 GB' },
      },
      {
        timestamp: new Date().toISOString(),
        changeType: 'os_version',
        changeAction: 'updated',
        subject: 'Operating System',
        beforeValue: { version: '22H2', build: '22621.3007' },
        afterValue: { version: '23H2', build: '22631.3007' },
      },
    ]);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.count).toBe(2);

    const rows = await withDbAccessContext(agentRequestContext(env.organization.id), () =>
      db.select().from(deviceChangeLog).where(eq(deviceChangeLog.deviceId, dev.id))
    );
    expect(rows.map((r) => r.changeType).sort()).toEqual(['hardware', 'os_version']);
  });
});

describe('device change ingest — one bad row does not sink the batch (real Postgres, #8301)', () => {
  runDb('keeps the valid rows of a batch when one row is rejected by Postgres, and strips NUL from the service account', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const ts = () => new Date().toISOString();

    const res = await submitChanges(env.organization.id, dev.agentId, [
      {
        timestamp: ts(),
        changeType: 'software',
        changeAction: 'added',
        subject: 'Google Chrome',
        afterValue: { version: '141.0' },
      },
      {
        // The reported shape: four NULs where "Loca" should be. jsonb cannot
        // hold U+0000 (22P05); the route strips it before insert (#8020).
        timestamp: ts(),
        changeType: 'service',
        changeAction: 'modified',
        subject: 'Google Updater Internal Service (GoogleUpdaterInternalService156.0.8067.0)',
        beforeValue: { account: '\u0000\u0000\u0000\u0000lSystem' },
        afterValue: { account: 'LocalSystem' },
      },
      {
        // A value Postgres still rejects after NUL stripping: a lone UTF-16
        // surrogate is valid JSON text but not valid jsonb (SQLSTATE class 22).
        timestamp: ts(),
        changeType: 'startup',
        changeAction: 'added',
        subject: 'Corrupt startup entry',
        afterValue: { path: 'C:\\bad\ud800path.exe' },
      },
      {
        timestamp: ts(),
        changeType: 'startup',
        changeAction: 'added',
        subject: 'OneDrive',
        afterValue: { path: 'C:\\Program Files\\OneDrive.exe' },
      },
    ]);

    expect(res.status).toBe(207);
    expect(await res.json()).toEqual({ success: true, count: 3, total: 4, dropped: 1, partial: true });

    // Read back in a fresh transaction: the rows must have survived the
    // request transaction's COMMIT, not only been counted.
    const rows = await withDbAccessContext(agentRequestContext(env.organization.id), () =>
      db.select().from(deviceChangeLog).where(eq(deviceChangeLog.deviceId, dev.id))
    );
    expect(rows.map((r) => r.subject).sort()).toEqual([
      'Google Chrome',
      'Google Updater Internal Service (GoogleUpdaterInternalService156.0.8067.0)',
      'OneDrive',
    ]);
    const service = rows.find((r) => r.changeType === 'service')!;
    expect(service.beforeValue).toEqual({ account: 'lSystem' });
    expect(service.afterValue).toEqual({ account: 'LocalSystem' });
  });

  runDb('keeps the first chunk when a row in a later chunk is rejected (savepoint per chunk)', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const dev = await insertDevice(env.organization.id, env.site.id);
    const base = Date.now();

    // 250 rows = two 200-row chunks; the bad row sits in the second chunk, so
    // chunk 1's rows are only kept if chunk 2's failure did not abort the
    // request transaction.
    const changes = Array.from({ length: 250 }, (_, i) => ({
      timestamp: new Date(base + i).toISOString(),
      changeType: 'software',
      changeAction: 'added',
      subject: `pkg-${i}`,
      afterValue: i === 210 ? { version: 'bad\ud800' } : { version: `1.${i}` },
    }));

    const res = await submitChanges(env.organization.id, dev.agentId, changes);

    expect(res.status).toBe(207);
    expect(await res.json()).toEqual({ success: true, count: 249, total: 250, dropped: 1, partial: true });

    const rows = await withDbAccessContext(agentRequestContext(env.organization.id), () =>
      db.select({ subject: deviceChangeLog.subject }).from(deviceChangeLog).where(eq(deviceChangeLog.deviceId, dev.id))
    );
    expect(rows).toHaveLength(249);
    const subjects = new Set(rows.map((r) => r.subject));
    expect(subjects.has('pkg-0')).toBe(true);
    expect(subjects.has('pkg-199')).toBe(true);
    expect(subjects.has('pkg-210')).toBe(false);
    expect(subjects.has('pkg-249')).toBe(true);
  });
});
