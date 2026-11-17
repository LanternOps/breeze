/**
 * Wisp analysis sessions W02 — `resolveAnalysisFrame` against real Postgres.
 *
 * Pins the filters the unit test can only mock: org isolation, the site
 * filter, decommissioned devices left out of a site/org frame, the grant
 * site allowlist, the frame cap, and an explicit device in another org.
 */
import './setup';
import { beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { withSystemDbAccessContext } from '../../db';
import { resolveAnalysisFrame } from '../../services/aiAgents/analysisFrame';
import { getTestDb } from './setup';
import { createDevice, createOrganization, createPartner, createSite } from './db-utils';

describe('resolveAnalysisFrame (integration)', () => {
  let orgA: string;
  let orgB: string;
  let s1: string;
  let s2: string;
  let s3: string;
  let s1Devices: string[];
  let s2Live: string;
  let s2Decommissioned: string;
  let bDevice: string;

  beforeEach(async () => {
    const partner = await createPartner();
    orgA = (await createOrganization({ partnerId: partner.id })).id;
    orgB = (await createOrganization({ partnerId: partner.id })).id;
    s1 = (await createSite({ orgId: orgA })).id;
    s2 = (await createSite({ orgId: orgA })).id;
    s3 = (await createSite({ orgId: orgB })).id;
    s1Devices = [(await createDevice({ orgId: orgA, siteId: s1 })).id, (await createDevice({ orgId: orgA, siteId: s1 })).id];
    s2Live = (await createDevice({ orgId: orgA, siteId: s2 })).id;
    s2Decommissioned = (await createDevice({ orgId: orgA, siteId: s2 })).id;
    await getTestDb().execute(sql`update devices set status = 'decommissioned' where id = ${s2Decommissioned}`);
    bDevice = (await createDevice({ orgId: orgB, siteId: s3 })).id;
  });

  const frame = (input: Partial<Parameters<typeof resolveAnalysisFrame>[0]> & Pick<Parameters<typeof resolveAnalysisFrame>[0], 'scope'>) =>
    withSystemDbAccessContext(() => resolveAnalysisFrame({
      orgId: orgA, deviceIds: [], siteId: null, allowedSiteIds: null, maxInputDevices: 50, maxFrameDevices: 1000, ...input,
    }));

  it('org expands to the org live devices only (another org and decommissioned devices absent)', async () => {
    const r = await frame({ scope: 'org' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.deviceIds].sort()).toEqual([...s1Devices, s2Live].sort());
    expect(r.deviceIds).not.toContain(s2Decommissioned);
    expect(r.deviceIds).not.toContain(bDevice);
    expect(r.scope).toEqual({ kind: 'org', siteId: null, deviceCount: 3 });
  });

  it('site expands to that site only; a site of another org is site_not_in_scope', async () => {
    const r = await frame({ scope: 'site', siteId: s1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.deviceIds].sort()).toEqual([...s1Devices].sort());
    expect(r.scope).toEqual({ kind: 'site', siteId: s1, deviceCount: 2 });
    await expect(frame({ scope: 'site', siteId: s3 })).resolves.toEqual({ ok: false, refusal: 'site_not_in_scope' });
  });

  it('the grant site allowlist narrows an org frame', async () => {
    await expect(frame({ scope: 'org', allowedSiteIds: [s2] })).resolves.toEqual({
      ok: true, deviceIds: [s2Live], scope: { kind: 'org', siteId: null, deviceCount: 1 },
    });
  });

  it('an allowlist naming only another org site leaves an empty frame', async () => {
    await expect(frame({ scope: 'org', allowedSiteIds: [s3] })).resolves.toEqual({ ok: false, refusal: 'frame_empty' });
  });

  it('over maxFrameDevices is frame_too_large', async () => {
    await expect(frame({ scope: 'org', maxFrameDevices: 2 })).resolves.toEqual({ ok: false, refusal: 'frame_too_large' });
  });

  it('an explicit device of another org is device_not_in_org; an explicit decommissioned device is kept', async () => {
    await expect(frame({ scope: 'devices', deviceIds: [bDevice] })).resolves.toEqual({ ok: false, refusal: 'device_not_in_org' });
    await expect(frame({ scope: 'devices', deviceIds: [s2Decommissioned] })).resolves.toEqual({
      ok: true, deviceIds: [s2Decommissioned], scope: { kind: 'devices', siteId: null, deviceCount: 1 },
    });
  });
});
