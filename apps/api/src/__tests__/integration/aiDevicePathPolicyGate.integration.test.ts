/**
 * The executeTool AI data policy gate against real Postgres under FORCE RLS
 * (#8854, W02 of #8852). The unit contract (aiTools.devicePathPolicy.contract)
 * fakes the context and the rows; this suite proves the partner-establishment
 * rule with the production context builder and the real policies:
 *
 * - an organization SESSION (currentPartnerId null by design) resolves its
 *   partner's real ceiling — `off` stays `off`, never the looser default;
 * - a device org the caller cannot see, a context partner that disagrees with
 *   the device org's partner, or no context at all → `unresolved` (off
 *   semantics), where the settings resolver would answer `no_user_profiles`.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';

import { db, withDbAccessContext, withSystemDbAccessContext, SYSTEM_DB_ACCESS_CONTEXT, type DbAccessContext } from '../../db';
import { aiDataPolicies } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { resolveAiDataPolicy } from '../../services/aiDataPolicy';
import { applyDevicePathPolicy, resolveDevicePolicyForGate } from '../../services/aiDevicePathPolicy';
import { createOrganization, createPartner } from './db-utils';

const orgSessionCtx = (orgId: string): DbAccessContext =>
  buildDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId], partnerId: null, userId: null });
const partnerCtx = (partnerId: string, orgIds: string[]): DbAccessContext =>
  buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: orgIds, partnerId, userId: null });

const createdPartnerIds: string[] = [];
const createdOrgIds: string[] = [];
let a: { partnerId: string; orgId: string };
let b: { partnerId: string; orgId: string };

beforeEach(async () => {
  const pa = await createPartner();
  const pb = await createPartner();
  const oa = await createOrganization({ partnerId: pa.id });
  const ob = await createOrganization({ partnerId: pb.id });
  createdPartnerIds.push(pa.id, pb.id);
  createdOrgIds.push(oa.id, ob.id);
  a = { partnerId: pa.id, orgId: oa.id };
  b = { partnerId: pb.id, orgId: ob.id };
});

afterEach(async () => {
  const partnerIds = createdPartnerIds.splice(0);
  const orgIds = createdOrgIds.splice(0);
  await withSystemDbAccessContext(async () => {
    if (partnerIds.length > 0) await db.delete(aiDataPolicies).where(inArray(aiDataPolicies.partnerId, partnerIds));
    if (orgIds.length > 0) await db.delete(aiDataPolicies).where(inArray(aiDataPolicies.orgId, orgIds));
  });
});

const seedCeiling = (partnerId: string, deviceFileReadLevel: 'off' | 'no_user_profiles' | 'any_with_approval') =>
  withSystemDbAccessContext(() => db.insert(aiDataPolicies).values({ partnerId, deviceFileReadLevel }));

const PROFILE_READ = { deviceId: '00000000-0000-0000-0000-000000000000', action: 'read', path: 'C:\\Users\\bob\\Documents\\a.docx' };

describe('executeTool AI data policy gate under RLS', () => {
  it('org SESSION (currentPartnerId null): the partner ceiling off stays off', async () => {
    await seedCeiling(a.partnerId, 'off');
    const ctx = orgSessionCtx(a.orgId);
    expect(ctx.currentPartnerId).toBeNull();
    const policy = await withDbAccessContext(ctx, () => resolveDevicePolicyForGate([{ orgId: a.orgId }]));
    expect(policy).toEqual({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'partner' } });
    const verdict = await withDbAccessContext(ctx, () => applyDevicePathPolicy('file_operations', PROFILE_READ, [{ orgId: a.orgId }]));
    expect(verdict).toMatchObject({ ok: false, condition: 'policy_denied', policy: { level: 'off', source: 'partner' } });
  });

  it('org SESSION with an any_with_approval ceiling reads a profile path', async () => {
    await seedCeiling(a.partnerId, 'any_with_approval');
    const verdict = await withDbAccessContext(orgSessionCtx(a.orgId), () =>
      applyDevicePathPolicy('file_operations', PROFILE_READ, [{ orgId: a.orgId }]));
    expect(verdict).toEqual({ ok: true });
  });

  it('a device org the caller cannot see is unresolved, where the settings resolver answers the default', async () => {
    await seedCeiling(b.partnerId, 'any_with_approval');
    const ctx = orgSessionCtx(a.orgId);
    // The fail-open the gate must not inherit: the settings resolver maps an
    // invisible org to the built-in default.
    const settings = await withDbAccessContext(ctx, () => resolveAiDataPolicy(b.orgId));
    expect(settings.source.deviceFileReadLevel).toBe('default');
    const policy = await withDbAccessContext(ctx, () => resolveDevicePolicyForGate([{ orgId: b.orgId }]));
    expect(policy).toEqual({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'unresolved' } });
  });

  it("a context partner that is not the device org's partner is unresolved", async () => {
    await seedCeiling(a.partnerId, 'any_with_approval');
    const mismatched: DbAccessContext = { ...orgSessionCtx(a.orgId), currentPartnerId: b.partnerId };
    const policy = await withDbAccessContext(mismatched, () => resolveDevicePolicyForGate([{ orgId: a.orgId }]));
    expect(policy.source.deviceFileReadLevel).toBe('unresolved');
    const wrongGrant = partnerCtx(b.partnerId, [a.orgId]);
    const viaGrant = await withDbAccessContext(wrongGrant, () => resolveDevicePolicyForGate([{ orgId: a.orgId }]));
    expect(viaGrant.source.deviceFileReadLevel).toBe('unresolved');
  });

  it('no DB context at all is unresolved', async () => {
    await seedCeiling(a.partnerId, 'any_with_approval');
    const policy = await resolveDevicePolicyForGate([{ orgId: a.orgId }]);
    expect(policy).toEqual({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'unresolved' } });
  });

  it('the partner scope and system scope resolve the real ceiling', async () => {
    await seedCeiling(a.partnerId, 'any_with_approval');
    const viaPartner = await withDbAccessContext(partnerCtx(a.partnerId, [a.orgId]), () => resolveDevicePolicyForGate([{ orgId: a.orgId }]));
    expect(viaPartner).toEqual({ deviceFileReadLevel: 'any_with_approval', source: { deviceFileReadLevel: 'partner' } });
    const viaSystem = await withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, () => resolveDevicePolicyForGate([{ orgId: a.orgId }]));
    expect(viaSystem.deviceFileReadLevel).toBe('any_with_approval');
  });

  it('mixed device orgs: the strictest established level wins', async () => {
    await seedCeiling(a.partnerId, 'any_with_approval');
    await seedCeiling(b.partnerId, 'off');
    const policy = await withDbAccessContext(SYSTEM_DB_ACCESS_CONTEXT, () =>
      resolveDevicePolicyForGate([{ orgId: a.orgId }, { orgId: b.orgId }]));
    expect(policy).toEqual({ deviceFileReadLevel: 'off', source: { deviceFileReadLevel: 'partner' } });
  });
});
