/**
 * Org merge and the Entra tenant proof (portal registration W4 #11381, plan D8 /
 * OD7, spec §5.4): `client_ai_tenant_mappings` stays `keep-survivor`, plus the
 * pre-walk `entra_tenant_conflict` blocker, through the real engine
 * (executeOrgMerge / previewOrgMerge) on real Postgres.
 *
 * The race where a proof lands between preview and execute lives in
 * portalEntraTenantProof.integration.test.ts. The race against an ABSENT
 * mapping row (which FOR UPDATE cannot lock) is the last describe below.
 */
import './setup';

// config/env.ts reads this at import time; the AI for Office admin group is
// dark (404) without it.
vi.hoisted(() => {
  process.env.CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID || '11111111-1111-4111-8111-111111111111';
});

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import { createOrganization, createPartner, createUser, setupTestEnvironment } from './db-utils';
import { clientAiTenantMappings, organizations, partners } from '../../db/schema';
import { runOutsideDbContext } from '../../db';
import * as orgMergeModule from '../../services/orgMerge';
import {
  OrgMergeBlockedError,
  executeOrgMerge,
  previewOrgMerge,
} from '../../services/orgMerge';
import {
  PortalEntraProofError,
  findOrgByProvenEntraTenant,
  recordEntraTenantProof,
} from '../../services/portalEntraTenantProof';
import { createAccessToken } from '../../services/jwt';
import { clientAiAdminRoutes } from '../../routes/clientAi/admin';

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

/**
 * The absent-row race (review finding on D8): the loser's mapping is proven and
 * the survivor has NONE, so the Phase-B recheck passes and its FOR UPDATE locks
 * nothing on the survivor's side. A proof (or the AI for Office PUT) that
 * inserted the survivor's mapping before the keep-survivor walk would make the
 * walk drop the loser's proven mapping. Every writer that can create an org's
 * mapping therefore takes the per-org lock
 * `pg_advisory_xact_lock(hashtext('portal-entra-org:' || org_id::text))`, which
 * the merge holds for both orgs for all of Phase B.
 */
describe('merge vs a mapping created for an unmapped org (per-org portal Entra lock)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  const orgLockKey = (orgId: string) => sql`hashtext('portal-entra-org:' || ${orgId}::uuid::text)`;

  async function waitersOnOrgLock(orgId: string): Promise<number> {
    const rows = await admin().execute(sql`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
         AND objid::bigint = (${orgLockKey(orgId)}::bigint & 4294967295)`) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * 'queued' once every org has its expected number of sessions waiting on its
   * lock; 'settled' as soon as any operation finished instead (it never waited).
   */
  async function untilQueued(waiters: Map<string, number>, ops: Array<Promise<unknown>>): Promise<'queued' | 'settled'> {
    let settled = false;
    for (const op of ops) op.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 15_000;
    for (;;) {
      let all = true;
      for (const [orgId, count] of waiters) {
        if ((await waitersOnOrgLock(orgId)) < count) { all = false; break; }
      }
      if (all) return 'queued';
      if (settled) return 'settled';
      if (Date.now() > deadline) throw new Error('the writers never queued on the per-org lock');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  const proofRun = (orgId: string, tenantId: string, byUserId: string) => ({
    orgId,
    tenantId,
    via: 'proof_run' as const,
    evidence: { adminOid: randomUUID(), runId: randomUUID() },
    provenByUserId: byUserId,
  });

  it('a proof for the unmapped survivor that starts after the Phase-B recheck waits for the merge; the proven loser mapping is adopted, not dropped', async () => {
    const f = await pair();
    const loserMapping = await seedMapping(f.loser.id, true);
    const freshTenant = randomUUID();

    let proof = null as Promise<unknown> | null;
    let race = null as 'queued' | 'settled' | null;
    const realRecheck = orgMergeModule.assertMergeIsolationSafe;
    vi.spyOn(orgMergeModule, 'assertMergeIsolationSafe').mockImplementationOnce(async (...args) => {
      // The real recheck has run: the loser's proven row is locked and the
      // survivor has no row. The proof now runs on its own connection.
      await realRecheck(...args);
      proof = runOutsideDbContext(() => recordEntraTenantProof(proofRun(f.survivor.id, freshTenant, f.actor.id)));
      race = await untilQueued(new Map([[f.survivor.id, 1]]), [proof]);
    });

    const result = await f.merge();
    const outcome = await proof!.then(() => null, (err: unknown) => err);

    expect(race).toBe('queued');
    expect(result.tables.client_ai_tenant_mappings).toMatchObject({ dropped: 0 });
    // The proof ran after the merge committed, against the adopted mapping.
    expect(outcome).toBeInstanceOf(PortalEntraProofError);
    expect(outcome).toMatchObject({ code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT' });
    expect(await mappingById(loserMapping.id)).toMatchObject({
      orgId: f.survivor.id,
      entraTenantId: loserMapping.entraTenantId,
      provenAt: PROVEN_AT,
      provenVia: 'proof_run',
    });
    expect(await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.entraTenantId, freshTenant)))
      .toEqual([]);
  });

  it('the tenant proof and the AI for Office PUT queue on that same per-org lock', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, env.partner.id));
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/client-ai/admin', clientAiAdminRoutes);
    const putOrg = env.organization;
    const proofOrg = await createOrganization({ partnerId: env.partner.id });
    const putTenant = randomUUID();
    const proofTenant = randomUUID();

    let ops = null as [Promise<Response>, Promise<unknown>] | null;
    let race = null as 'queued' | 'settled' | null;
    // A separate connection holds both orgs' locks, as a merge's Phase B would.
    await admin().transaction(async (tx) => {
      for (const orgId of [putOrg.id, proofOrg.id].sort()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${orgLockKey(orgId)})`);
      }
      ops = [
        Promise.resolve(app.request(`/client-ai/admin/orgs/${putOrg.id}/tenant-mapping`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ entraTenantId: putTenant }),
        })),
        recordEntraTenantProof(proofRun(proofOrg.id, proofTenant, env.user.id)),
      ];
      race = await untilQueued(new Map([[putOrg.id, 1], [proofOrg.id, 1]]), ops);
    });

    expect(race).toBe('queued');
    const [put, proof] = await Promise.all(ops!);
    expect(put.status).toBe(200);
    expect(proof).toEqual({ displaced: null });
    const [putRow] = await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, putOrg.id));
    expect(putRow).toMatchObject({ entraTenantId: putTenant, provenAt: null });
    const [proofRow] = await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, proofOrg.id));
    expect(proofRow).toMatchObject({ entraTenantId: proofTenant, provenVia: 'proof_run' });
  });
});
