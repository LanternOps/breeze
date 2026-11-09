/**
 * Org merge and the Entra tenant proof (portal registration W4 #11381, plan D8 /
 * OD7, spec §5.4): `client_ai_tenant_mappings` stays `keep-survivor`, plus the
 * pre-walk `entra_tenant_conflict` blocker, through the real engine
 * (executeOrgMerge / previewOrgMerge) on real Postgres.
 *
 * The race where a proof lands between preview and execute lives in
 * portalEntraTenantProof.integration.test.ts.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser } from './db-utils';
import { clientAiTenantMappings, organizations } from '../../db/schema';
import {
  OrgMergeBlockedError,
  executeOrgMerge,
  previewOrgMerge,
} from '../../services/orgMerge';
import { findOrgByProvenEntraTenant } from '../../services/portalEntraTenantProof';

const admin = () => getTestDb();
const PROVEN_AT = new Date('2027-01-01T00:00:00Z');
const BLOCKED_TEXT = 'Both organizations are linked to a Microsoft tenant and the merged-away one is proven. Remove one tenant link first.';

let priorDrain: string | undefined;
beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

async function pair() {
  const partner = await createPartner();
  const loser = await createOrganization({ partnerId: partner.id });
  const survivor = await createOrganization({ partnerId: partner.id });
  const actor = await createUser({ partnerId: partner.id, email: `merge-${randomUUID()}@msp.test` });
  const merge = () => executeOrgMerge({
    loserOrgId: loser.id, survivorOrgId: survivor.id, partnerId: partner.id,
    performedBy: actor.id, performedByEmail: actor.email,
  });
  return { partner, loser, survivor, actor, merge };
}

async function seedMapping(orgId: string, proven: boolean) {
  const [row] = await admin().insert(clientAiTenantMappings).values({
    orgId,
    entraTenantId: randomUUID(),
    ...(proven ? {
      provenAt: PROVEN_AT,
      provenVia: 'proof_run' as const,
      provenEvidence: { via: 'proof_run' as const, adminOid: randomUUID(), runId: randomUUID() },
    } : {}),
  }).returning();
  return row!;
}

async function mappingById(id: string) {
  const [row] = await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.id, id));
  return row ?? null;
}

describe('org merge: client_ai_tenant_mappings and the tenant proof', () => {
  it('merge refuses entra_tenant_conflict when the loser mapping is proven and the survivor has a mapping', async () => {
    const f = await pair();
    const loserMapping = await seedMapping(f.loser.id, true);
    const survivorMapping = await seedMapping(f.survivor.id, false);

    const preview = await previewOrgMerge(f.loser.id, f.survivor.id, f.partner.id);
    expect(preview).toMatchObject({ verdict: 'blocked', blockerCodes: ['entra_tenant_conflict'] });
    expect(preview.blockers).toEqual([BLOCKED_TEXT]);

    const error = await f.merge().then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(OrgMergeBlockedError);
    expect(error).toMatchObject({ code: 'ORG_MERGE_BLOCKED', blockerCodes: ['entra_tenant_conflict'], message: BLOCKED_TEXT });

    // Refused pre-fence: nothing moved, the loser is still a live org.
    expect(await mappingById(loserMapping.id)).toMatchObject({ orgId: f.loser.id, provenAt: PROVEN_AT });
    expect(await mappingById(survivorMapping.id)).toMatchObject({ orgId: f.survivor.id });
    const [org] = await admin().select({ status: organizations.status }).from(organizations)
      .where(eq(organizations.id, f.loser.id));
    expect(org?.status).toBe('active');
  });

  it('merge adopts a proven loser mapping when the survivor has none, keeping the proof', async () => {
    const f = await pair();
    const loserMapping = await seedMapping(f.loser.id, true);

    const preview = await previewOrgMerge(f.loser.id, f.survivor.id, f.partner.id);
    expect(preview.blockerCodes).not.toContain('entra_tenant_conflict');

    await f.merge();

    const after = await mappingById(loserMapping.id);
    expect(after).toMatchObject({
      orgId: f.survivor.id,
      entraTenantId: loserMapping.entraTenantId,
      provenAt: PROVEN_AT,
      provenVia: 'proof_run',
      provenEvidence: loserMapping.provenEvidence,
    });
    // Sign-in now resolves the tenant to the survivor.
    expect(await findOrgByProvenEntraTenant(loserMapping.entraTenantId)).toEqual({ orgId: f.survivor.id, partnerId: f.partner.id });
  });

  it('merge drops an unproven loser mapping when the survivor has one (unchanged behaviour)', async () => {
    const f = await pair();
    const loserMapping = await seedMapping(f.loser.id, false);
    const survivorMapping = await seedMapping(f.survivor.id, true);

    const preview = await previewOrgMerge(f.loser.id, f.survivor.id, f.partner.id);
    expect(preview.blockerCodes).not.toContain('entra_tenant_conflict');

    const result = await f.merge();

    expect(await mappingById(loserMapping.id)).toBeNull();
    expect(await mappingById(survivorMapping.id)).toMatchObject({ orgId: f.survivor.id, provenAt: PROVEN_AT });
    expect(result.tables.client_ai_tenant_mappings).toMatchObject({ dropped: 1 });
  });
});
