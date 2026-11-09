/**
 * #11426 — the same-org rollup of device concerns, against real Postgres.
 *
 * Device concerns are raised the way the assessment finalizer raises them
 * (`upsertConcern` with a `pattern`), or unsigned with no pattern at all (every
 * device concern in production before #11426). rollupDeviceConcerns then folds
 * ≥ 3 live device concerns of one org sharing a pattern into ONE org-level
 * parent (subject `incident`, never the org's own slot — #10386) holding them
 * in `child_concern_ids`, and resolves the parent (`children_resolved`) once
 * every child is resolved. Two concerns, or the same pattern spread over two
 * orgs, roll up nothing.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { wispConcerns } from '../../db/schema';
import { resolveConcern, setConcernPattern, upsertConcern } from '../../services/wisp/concerns';
import { rollupDeviceConcerns } from '../../services/wisp/concernRollup';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null,
};
const asSystem = <T>(fn: () => Promise<T>) => withDbAccessContext(SYSTEM_CTX, fn);

afterEach(() => {
  vi.unstubAllEnvs();
});

function enableWisp() {
  vi.stubEnv('IS_HOSTED', 'true');
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  vi.stubEnv('BREEZE_WISP_ENABLED', 'true');
}

async function seedOrg(partnerId: string, hostnames: string[]) {
  const org = await createOrganization({ partnerId });
  const site = await createSite({ orgId: org.id });
  const devices: string[] = [];
  for (const hostname of hostnames) devices.push((await createDevice({ orgId: org.id, siteId: site.id, hostname })).id);
  return { orgId: org.id, devices };
}

async function raiseDevice(partnerId: string, orgId: string, deviceId: string, summary: string, opts: { pattern?: string; severity?: 'low' | 'medium' | 'high' } = {}) {
  const { id } = await upsertConcern({
    partnerId, orgId, subject: { kind: 'device', id: deviceId }, summary,
    severity: opts.severity ?? 'low', evidence: {}, ...(opts.pattern ? { pattern: opts.pattern } : {}),
  });
  return id;
}

const parentsOf = (partnerId: string, orgId: string) => asSystem(() => db.select().from(wispConcerns)
  .where(and(eq(wispConcerns.partnerId, partnerId), eq(wispConcerns.orgId, orgId), eq(wispConcerns.subjectKind, 'incident'))));

describe('wisp concern rollup (real Postgres)', () => {
  it('three device concerns sharing a pattern → one org-level parent with three children; all resolved → parent resolved', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['tz-front', 'tz-back', 'tz-op']);
    const ids = [
      await raiseDevice(partner.id, a.orgId, a.devices[0]!, 'Phantom incident_opened event', { pattern: 'phantom_incident_event', severity: 'low' }),
      await raiseDevice(partner.id, a.orgId, a.devices[1]!, 'incident_opened event with no incident', { pattern: 'phantom_incident_event', severity: 'high' }),
      await raiseDevice(partner.id, a.orgId, a.devices[2]!, 'Agent reports an incident Breeze never opened', { pattern: 'phantom_incident_event' }),
    ];

    const first = await rollupDeviceConcerns(new Date());
    expect(first.opened).toBeGreaterThanOrEqual(1);
    const [p, ...extra] = await parentsOf(partner.id, a.orgId);
    expect(extra).toHaveLength(0);
    expect(p).toMatchObject({
      status: 'open',
      severity: 'high',
      summary: '3 devices: phantom incident event',
      signature: `${a.orgId}:phantom_incident_event`,
      raisedByGrantId: null,
    });
    expect(p!.subjectId).not.toBe(a.orgId);
    expect([...p!.childConcernIds].sort()).toEqual([...ids].sort());
    expect(p!.evidence).toMatchObject({ rollup: 'device_pattern', pattern: 'phantom_incident_event', deviceCount: 3 });

    // Idempotent: a second tick changes nothing.
    await rollupDeviceConcerns(new Date());
    const again = await parentsOf(partner.id, a.orgId);
    expect(again).toHaveLength(1);
    expect(again[0]!.updatedAt.getTime()).toBe(p!.updatedAt.getTime());

    for (const id of ids.slice(0, 2)) await resolveConcern(id, {}, 'fixed');
    await rollupDeviceConcerns(new Date());
    const [stillOpen] = await parentsOf(partner.id, a.orgId);
    expect(stillOpen).toMatchObject({ status: 'open', summary: '1 device: phantom incident event', severity: 'low' });

    await resolveConcern(ids[2]!, {}, 'fixed');
    await rollupDeviceConcerns(new Date());
    const [closed] = await parentsOf(partner.id, a.orgId);
    expect(closed).toMatchObject({ status: 'resolved', outcome: 'children_resolved' });
  });

  it('unsigned device concerns (no pattern) roll up by their summary with the device names stripped', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['FRONTDESK', 'reception', 'Lab-Bench']);
    const ids: string[] = [];
    for (const [i, host] of ['FRONTDESK', 'reception', 'Lab-Bench'].entries()) {
      ids.push(await raiseDevice(partner.id, a.orgId, a.devices[i]!, `${host}: incident_opened event, but Breeze has no incidents (${i + 2} events)`));
    }
    const unsigned = await asSystem(() => db.select({ signature: wispConcerns.signature, evidence: wispConcerns.evidence })
      .from(wispConcerns).where(eq(wispConcerns.id, ids[0]!)));
    expect(unsigned[0]).toEqual({ signature: null, evidence: {} });

    await rollupDeviceConcerns(new Date());
    const [p, ...extra] = await parentsOf(partner.id, a.orgId);
    expect(extra).toHaveLength(0);
    expect(p).toMatchObject({ summary: '3 devices: incident opened event', signature: `${a.orgId}:incident_opened_event` });
    expect([...p!.childConcernIds].sort()).toEqual([...ids].sort());
  });

  it('two concerns, or one pattern spread across two orgs, roll up nothing', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['a1', 'a2']);
    const b = await seedOrg(partner.id, ['b1', 'b2']);
    for (const org of [a, b]) {
      for (const d of org.devices) await raiseDevice(partner.id, org.orgId, d, 'Chrome has critical CVEs', { pattern: 'browser_critical_cves' });
    }
    await rollupDeviceConcerns(new Date());
    expect(await parentsOf(partner.id, a.orgId)).toHaveLength(0);
    expect(await parentsOf(partner.id, b.orgId)).toHaveLength(0);
  });

  it('the parent never takes the org slot: a model-raised org concern still opens beside it', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['x1', 'x2', 'x3']);
    for (const d of a.devices) await raiseDevice(partner.id, a.orgId, d, 'Patch job failed: command timed out', { pattern: 'patch_job_timeout' });
    await rollupDeviceConcerns(new Date());
    const [p] = await parentsOf(partner.id, a.orgId);
    expect(p).toMatchObject({ subjectKind: 'incident', status: 'open' });
    const org = await upsertConcern({
      partnerId: partner.id, orgId: a.orgId, subject: { kind: 'org', id: a.orgId },
      summary: `Backups have not run for the whole org ${randomUUID().slice(0, 4)}`, severity: 'high', evidence: {},
    });
    expect(org.created).toBe(true);
    expect(org.id).not.toBe(p!.id);
  });

  it('one pattern with three devices in each of two orgs → one parent per org, never one across them', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['a1', 'a2', 'a3']);
    const b = await seedOrg(partner.id, ['b1', 'b2', 'b3']);
    const byOrg = new Map<string, string[]>();
    for (const org of [a, b]) {
      const ids: string[] = [];
      for (const d of org.devices) ids.push(await raiseDevice(partner.id, org.orgId, d, 'Chrome has critical CVEs', { pattern: 'browser_critical_cves' }));
      byOrg.set(org.orgId, ids);
    }
    await rollupDeviceConcerns(new Date());
    for (const org of [a, b]) {
      const parents = await parentsOf(partner.id, org.orgId);
      expect(parents).toHaveLength(1);
      expect([...parents[0]!.childConcernIds].sort()).toEqual([...byOrg.get(org.orgId)!].sort());
      expect(parents[0]!.signature).toBe(`${org.orgId}:browser_critical_cves`);
    }
  });

  it('a person-dismissed parent is not re-opened for 24 h, then is', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['d1', 'd2', 'd3']);
    for (const d of a.devices) await raiseDevice(partner.id, a.orgId, d, 'Phantom incident event', { pattern: 'phantom_incident_event' });
    await rollupDeviceConcerns(new Date());
    const [p] = await parentsOf(partner.id, a.orgId);
    await asSystem(() => db.update(wispConcerns).set({ status: 'dismissed', updatedAt: new Date() }).where(eq(wispConcerns.id, p!.id)));

    await rollupDeviceConcerns(new Date());
    expect((await parentsOf(partner.id, a.orgId)).filter((r) => r.status === 'open')).toHaveLength(0);

    await asSystem(() => db.update(wispConcerns).set({ updatedAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(wispConcerns.id, p!.id)));
    await rollupDeviceConcerns(new Date());
    expect((await parentsOf(partner.id, a.orgId)).filter((r) => r.status === 'open')).toHaveLength(1);
  });

  it('a snoozed child keeps its parent open', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['s1', 's2', 's3']);
    const ids: string[] = [];
    for (const d of a.devices) ids.push(await raiseDevice(partner.id, a.orgId, d, 'Phantom incident event', { pattern: 'phantom_incident_event' }));
    await rollupDeviceConcerns(new Date());
    await resolveConcern(ids[0]!, {}, 'fixed');
    await resolveConcern(ids[1]!, {}, 'fixed');
    await asSystem(() => db.update(wispConcerns).set({ status: 'snoozed' }).where(eq(wispConcerns.id, ids[2]!)));
    await rollupDeviceConcerns(new Date());
    const [p] = await parentsOf(partner.id, a.orgId);
    expect(p).toMatchObject({ status: 'open', summary: '1 device: phantom incident event' });
  });

  it('setConcernPattern stamps only the key on a live concern; re-patterned children leave their old parent', async () => {
    enableWisp();
    const partner = await createPartner();
    const a = await seedOrg(partner.id, ['r1', 'r2', 'r3']);
    const ids: string[] = [];
    for (const d of a.devices) {
      const { id } = await upsertConcern({
        partnerId: partner.id, orgId: a.orgId, subject: { kind: 'device', id: d },
        summary: 'Patch job failed', severity: 'medium', evidence: { jobId: 'j-1' }, pattern: 'patch_job_timeout',
      });
      ids.push(id);
    }
    await rollupDeviceConcerns(new Date());
    const [old] = await parentsOf(partner.id, a.orgId);
    expect(old).toMatchObject({ status: 'open', signature: `${a.orgId}:patch_job_timeout` });

    const [before] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, ids[0]!)));
    for (const id of ids) await setConcernPattern(id, 'patch_timeout');
    const [after] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, ids[0]!)));
    expect(after!.evidence).toEqual({ jobId: 'j-1', pattern: 'patch_timeout' });
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());

    await rollupDeviceConcerns(new Date());
    const rows = await parentsOf(partner.id, a.orgId);
    expect(rows.find((r) => r.id === old!.id)).toMatchObject({ status: 'resolved', outcome: 'children_resolved' });
    const fresh = rows.find((r) => r.status === 'open');
    expect(fresh).toMatchObject({ signature: `${a.orgId}:patch_timeout` });
    expect([...fresh!.childConcernIds].sort()).toEqual([...ids].sort());

    // A closed concern is never stamped.
    await resolveConcern(ids[0]!, {}, 'fixed');
    await setConcernPattern(ids[0]!, 'something_else');
    const [closed] = await asSystem(() => db.select().from(wispConcerns).where(eq(wispConcerns.id, ids[0]!)));
    expect(closed!.evidence).toEqual({ jobId: 'j-1', pattern: 'patch_timeout' });
  });
});
