import './setup';
import { describe, expect, it } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { moveDeviceOrgInTransaction } from '../../services/deviceOrgMove/moveDeviceOrgInTransaction';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const admin = (query: SQL) => getTestDb().execute(query);
const orgContext = (orgId: string) => ({
  scope: 'organization' as const, orgId, accessibleOrgIds: [orgId],
  accessiblePartnerIds: [], userId: null,
});
async function fixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const device = await createDevice({ orgId: org.id, siteId: site.id });
  return { partner, org, site, device };
}
function attempt(t: Awaited<ReturnType<typeof fixture>>, outcome: string | null = 'pending', relayId: string | null = null) {
  return sql`INSERT INTO device_wake_attempts (org_id, device_id, outcome, relay_device_id)
    VALUES (${t.org.id}::uuid, ${t.device.id}::uuid, ${outcome}, ${relayId}::uuid) RETURNING id`;
}
async function errorCode(work: () => Promise<unknown>) {
  try { await work(); } catch (error) {
    const e = error as { code?: string; cause?: { code?: string } };
    return e.cause?.code ?? e.code;
  }
}

describe('device wake tables', () => {
  it('forged cross-org insert fails with 42501 as breeze_app', async () => {
    const a = await fixture();
    const b = await fixture();
    const role = await withSystemDbAccessContext(() => db.execute(sql`
      SELECT current_user AS who, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect(role[0]).toMatchObject({ who: 'breeze_app', rolsuper: false, rolbypassrls: false });
    for (const query of [attempt(b), sql`INSERT INTO device_wake_status (device_id, org_id)
      VALUES (${b.device.id}::uuid, ${b.org.id}::uuid)`]) {
      expect(await errorCode(() => withDbAccessContext(orgContext(a.org.id), () => db.execute(query)))).toBe('42501');
      await withDbAccessContext(orgContext(b.org.id), () => db.execute(query));
    }
  });

  it('a foreign org cannot read, change or delete rows; the owning org can', async () => {
    const a = await fixture();
    const b = await fixture();
    await admin(sql`INSERT INTO device_wake_status (device_id, org_id, consecutive_timeouts)
      VALUES (${a.device.id}::uuid, ${a.org.id}::uuid, 0)`);
    await admin(attempt(a));
    const expectRows = async (orgId: string, count: number) => {
      const work = async (query: SQL) => (await withDbAccessContext(orgContext(orgId), () => db.execute(query))).length;
      for (const [table, write] of [
        ['device_wake_status', sql`consecutive_timeouts = 1`],
        ['device_wake_attempts', sql`send_count = 2`],
      ] as const) {
        const name = sql.raw(table);
        const where = sql`device_id = ${a.device.id}::uuid`;
        expect(await work(sql`SELECT 1 FROM ${name} WHERE ${where}`)).toBe(count);
        expect(await work(sql`UPDATE ${name} SET ${write} WHERE ${where} RETURNING 1`)).toBe(count);
        expect(await work(sql`DELETE FROM ${name} WHERE ${where} RETURNING 1`)).toBe(count);
      }
    };
    await expectRows(b.org.id, 0);
    await expectRows(a.org.id, 1);
  });

  it('a second open attempt for one device violates the partial unique index, 23505', async () => {
    const t = await fixture();
    await admin(attempt(t));
    expect(await errorCode(() => admin(attempt(t, 'sent')))).toBe('23505');
  });

  it('rejects a NULL outcome with 23502', async () => {
    const t = await fixture();
    expect(await errorCode(() => admin(attempt(t, null)))).toBe('23502');
  });

  it('a closed attempt does not block a new open one', async () => {
    const t = await fixture();
    await admin(attempt(t));
    await admin(sql`UPDATE device_wake_attempts SET outcome = 'timed_out' WHERE device_id = ${t.device.id}::uuid`);
    expect(await admin(attempt(t, 'sent'))).toHaveLength(1);
  });

  it('relay delete sets relay_device_id NULL and keeps the attempt', async () => {
    const t = await fixture();
    const relay = await createDevice({ orgId: t.org.id, siteId: t.site.id });
    await admin(attempt(t, 'sent', relay.id));
    await admin(sql`DELETE FROM devices WHERE id = ${relay.id}::uuid`);
    expect(await admin(sql`SELECT relay_device_id, outcome FROM device_wake_attempts WHERE device_id = ${t.device.id}::uuid`))
      .toEqual([{ relay_device_id: null, outcome: 'sent' }]);
  });

  it('org move deletes attempts, keeps status, and clears last_came_online_at, proof_fingerprint, consecutive_timeouts', async () => {
    const t = await fixture();
    const target = await createOrganization({ partnerId: t.partner.id });
    const targetSite = await createSite({ orgId: target.id });
    const actor = await createUser({ partnerId: t.partner.id });
    await admin(attempt(t, 'timed_out'));
    const relay = await createDevice({ orgId: t.org.id, siteId: t.site.id });
    await admin(attempt(t, 'pending', relay.id));
    expect(await admin(sql`SELECT id FROM device_wake_attempts WHERE device_id = ${t.device.id}::uuid`)).toHaveLength(2);
    await admin(sql`INSERT INTO device_wake_status
      (device_id, org_id, readiness_state, fingerprint, last_came_online_at, proof_fingerprint, consecutive_timeouts)
      VALUES (${t.device.id}::uuid, ${t.org.id}::uuid, 'ready', 'adapter-v1', now(), 'adapter-v1', 3)`);
    await withSystemDbAccessContext(() => db.transaction((tx) => moveDeviceOrgInTransaction(tx, {
      deviceId: t.device.id, sourceOrgId: t.org.id, targetOrgId: target.id,
      targetSiteId: targetSite.id, targetOrgName: 'target', deviceLinkGroupId: null,
      acceptCurrencyMismatch: false, actor: { userId: actor.id, allowedSiteIds: undefined },
      stepUp: null, via: 'generic_move',
    })));
    expect(await admin(sql`SELECT id FROM device_wake_attempts WHERE device_id = ${t.device.id}::uuid`)).toHaveLength(0);
    expect(await admin(sql`SELECT org_id, readiness_state, fingerprint, last_came_online_at, proof_fingerprint,
      consecutive_timeouts FROM device_wake_status WHERE device_id = ${t.device.id}::uuid`)).toEqual([{
      org_id: target.id, readiness_state: 'ready', fingerprint: 'adapter-v1', last_came_online_at: null,
      proof_fingerprint: null, consecutive_timeouts: 0,
    }]);
  });
});
