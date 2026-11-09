/**
 * Entra tenant proof: record, transfer, lookups, the AI for Office repoint and
 * the merge race (portal registration W4 #11381, plan Task 2, D7/D8, OD4).
 *
 * The service runs as breeze_app under forced RLS through the real `db` pool,
 * exactly as production calls it (no DB context held: request callers go
 * through runOutsideDbContext). Fixtures are seeded and read back over the
 * superuser connection. Task 8 appends the proof-run routes below.
 */
import './setup';

// config/env.ts reads this at import time; the AI for Office admin group is
// dark (404) without it.
vi.hoisted(() => {
  process.env.CLIENT_AI_ENTRA_CLIENT_ID = process.env.CLIENT_AI_ENTRA_CLIENT_ID || '11111111-1111-4111-8111-111111111111';
});

const mail = vi.hoisted(() => ({
  sent: [] as Array<{ to: string | string[]; partnerName: string; orgName: string; tenantId: string }>,
  fail: false,
  /** Runs inside the send, before it "delivers": lets a test look at the DB from there. */
  onSend: null as null | (() => Promise<void>),
}));

vi.mock('../../services/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/email')>()),
  getEmailService: () => ({
    sendPortalEntraTenantDisplaced: async (params: { to: string | string[]; partnerName: string; orgName: string; tenantId: string }) => {
      if (mail.onSend) await mail.onSend();
      if (mail.fail) throw new Error('smtp unavailable');
      mail.sent.push(params);
    },
  }),
}));

import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTestDb } from './setup';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  setupTestEnvironment,
} from './db-utils';
import {
  auditLogs,
  clientAiTenantMappings,
  m365Connections,
  partners,
  portalUserIdentities,
  portalUsers,
} from '../../db/schema';
import type { PortalEntraProofEvidence, PortalEntraProofVia } from '../../db/schema/clientAi';
import {
  PortalEntraProofError,
  findOrgByProvenEntraTenant,
  findProvenEntraTenantForOrg,
  getPortalEntraTenantStatus,
  proveEntraTenantFromM365Connection,
  recordEntraTenantProof,
  removePortalEntraTenant,
  type RecordEntraProofInput,
} from '../../services/portalEntraTenantProof';
import { entraIssuer } from '../../services/portalUserIdentities';
import { createAccessToken } from '../../services/jwt';
import { clientAiAdminRoutes } from '../../routes/clientAi/admin';
import * as orgMergeModule from '../../services/orgMerge';

const admin = () => getTestDb();
const newTenant = () => randomUUID();

beforeEach(() => {
  mail.sent = [];
  mail.fail = false;
  mail.onSend = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function seedMapping(
  orgId: string,
  tenantId: string,
  proof?: { via: PortalEntraProofVia; evidence: PortalEntraProofEvidence; at?: Date; byUserId?: string | null },
) {
  const [row] = await admin().insert(clientAiTenantMappings).values({
    orgId,
    entraTenantId: tenantId,
    ...(proof ? {
      provenAt: proof.at ?? new Date('2027-01-01T00:00:00Z'),
      provenVia: proof.via,
      provenEvidence: proof.evidence,
      provenByUserId: proof.byUserId ?? null,
    } : {}),
  }).returning();
  return row!;
}

const provenByConnection = (): { via: 'm365_connection'; evidence: PortalEntraProofEvidence } => ({
  via: 'm365_connection',
  evidence: { via: 'm365_connection', connectionId: randomUUID(), profile: 'customer-graph-read' },
});

async function mappingFor(orgId: string) {
  const [row] = await admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.orgId, orgId));
  return row ?? null;
}

async function mappingsForTenant(tenantId: string) {
  return admin().select().from(clientAiTenantMappings).where(eq(clientAiTenantMappings.entraTenantId, tenantId));
}

async function seedAccount(orgId: string, identityTenant: string | null) {
  const [user] = await admin().insert(portalUsers).values({
    orgId,
    email: `pu-${randomUUID()}@customer.test`,
    authMethod: identityTenant ? 'entra' : 'password',
    status: 'active',
    browserAccess: 'granted',
    // Well in the past, so a bump to now() is visibly later.
    updatedAt: new Date('2020-01-01T00:00:00Z'),
  }).returning();
  if (identityTenant) {
    const oid = randomUUID();
    await admin().insert(portalUserIdentities).values({
      orgId,
      portalUserId: user!.id,
      provider: 'entra',
      issuer: entraIssuer(identityTenant),
      subject: oid,
      entraTenantId: identityTenant,
      linkedVia: 'jit',
    });
  }
  return user!;
}

async function account(id: string) {
  const [row] = await admin().select({ authEpoch: portalUsers.authEpoch, updatedAt: portalUsers.updatedAt })
    .from(portalUsers).where(eq(portalUsers.id, id));
  return row!;
}

async function audits(orgId: string, action: string) {
  return admin().select({ orgId: auditLogs.orgId, details: auditLogs.details, actorId: auditLogs.actorId, actorType: auditLogs.actorType })
    .from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action)));
}

async function partnerAdmin(partnerId: string, opts: { status?: 'active' | 'disabled'; roleName?: string } = {}) {
  const role = await createRole({ name: opts.roleName ?? 'Partner Admin', scope: 'partner', partnerId });
  const user = await createUser({ partnerId, email: `admin-${randomUUID()}@msp.test`, status: opts.status ?? 'active' });
  await assignUserToPartner(user.id, partnerId, role.id, 'all');
  return user;
}

async function tenantOrg(name?: string) {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id, ...(name ? { name } : {}) });
  const tech = await createUser({ partnerId: partner.id, email: `tech-${randomUUID()}@msp.test` });
  return { partner, org, tech };
}

const proofRun = (orgId: string, tenantId: string, provenByUserId: string | null): RecordEntraProofInput => ({
  orgId,
  tenantId,
  via: 'proof_run',
  evidence: { adminOid: randomUUID(), runId: randomUUID() },
  provenByUserId,
});

const connectionProof = (orgId: string, tenantId: string, provenByUserId: string): RecordEntraProofInput => ({
  orgId,
  tenantId,
  via: 'm365_connection',
  evidence: { connectionId: randomUUID(), profile: 'customer-graph-read' },
  provenByUserId,
});

async function proofError(work: Promise<unknown>): Promise<PortalEntraProofError> {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err, 'expected a PortalEntraProofError').toBeInstanceOf(PortalEntraProofError);
  return err as PortalEntraProofError;
}

describe('recordEntraTenantProof', () => {
  it('proof run on an unmapped tenant creates the proven mapping with evidence and audits proven', async () => {
    const { partner, org, tech } = await tenantOrg();
    const tenant = newTenant();
    const now = new Date('2027-02-03T04:05:06.000Z');
    const input = proofRun(org.id, tenant.toUpperCase(), tech.id);

    expect(await recordEntraTenantProof(input, now)).toEqual({ displaced: null });

    const row = await mappingFor(org.id);
    expect(row).toMatchObject({
      entraTenantId: tenant, // stored lowercased, like the AI for Office PUT
      provenAt: now,
      provenVia: 'proof_run',
      provenByUserId: tech.id,
      provenEvidence: { via: 'proof_run', ...(input.evidence as object) },
      createdBy: tech.id,
    });
    const proven = await audits(org.id, 'organization.portal_identity_proof.proven');
    expect(proven).toHaveLength(1);
    expect(proven[0]).toMatchObject({ actorType: 'user', actorId: tech.id, details: { tenantId: tenant, via: 'proof_run' } });

    expect(await findProvenEntraTenantForOrg(org.id)).toEqual({ tenantId: tenant, provenAt: now });
    expect(await findOrgByProvenEntraTenant(tenant.toUpperCase())).toEqual({ orgId: org.id, partnerId: partner.id });
    expect(await getPortalEntraTenantStatus(org.id)).toEqual({
      tenantId: tenant, state: 'proven', provenAt: now.toISOString(), provenVia: 'proof_run', connectionTenantId: null,
    });
  });

  it('a proof run with no Breeze actor (provenByUserId null) audits as system and leaves createdBy empty', async () => {
    const { org } = await tenantOrg();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(org.id, tenant, null));
    expect(await mappingFor(org.id)).toMatchObject({ provenVia: 'proof_run', provenByUserId: null, createdBy: null });
    const [row] = await audits(org.id, 'organization.portal_identity_proof.proven');
    expect(row).toMatchObject({ actorType: 'system' });
  });

  it("proof run on the org's own unproven mapping proves it in place", async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();
    const seeded = await seedMapping(org.id, tenant);

    expect(await recordEntraTenantProof(proofRun(org.id, tenant, tech.id))).toEqual({ displaced: null });

    const row = await mappingFor(org.id);
    expect(row!.id).toBe(seeded.id);
    expect(row).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run', provenByUserId: tech.id, createdBy: null });
    expect(row!.provenAt).toBeInstanceOf(Date);
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ state: 'proven' });
  });

  it('proof refused when the org maps a different tenant (409 ORG_HAS_OTHER_TENANT), nothing written', async () => {
    const { org, tech } = await tenantOrg();
    const mapped = newTenant();
    const other = newTenant();
    await seedMapping(org.id, mapped);

    const err = await proofError(recordEntraTenantProof(proofRun(org.id, other, tech.id)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', httpStatus: 409 });

    expect(await mappingFor(org.id)).toMatchObject({ entraTenantId: mapped, provenAt: null, provenVia: null });
    expect(await mappingsForTenant(other)).toHaveLength(0);
    expect(await audits(org.id, 'organization.portal_identity_proof.proven')).toHaveLength(0);
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ tenantId: mapped, state: 'unproven' });
  });

  it("proof run displaces an unproven mapping in another partner's org: row deleted, audits on both orgs", async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome).toEqual({ displaced: { orgId: a.org.id, partnerId: a.partner.id, wasProven: false, epochsBumped: 0 } });
    expect(await mappingFor(a.org.id)).toBeNull();
    expect(await mappingFor(b.org.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run' });
    const displaced = await audits(a.org.id, 'organization.portal_identity_proof.displaced');
    expect(displaced).toHaveLength(1);
    expect(displaced[0]!.details).toEqual({ tenantId: tenant, displacedByOrgId: b.org.id, wasProven: false });
    expect(await audits(b.org.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
  });

  it("proof run displaces a proven mapping in another partner's org and bumps epochs of that org's tenant identities", async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, provenByConnection());
    const first = await seedAccount(a.org.id, tenant);
    const second = await seedAccount(a.org.id, tenant);
    const before = await account(first.id);

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced).toEqual({ orgId: a.org.id, partnerId: a.partner.id, wasProven: true, epochsBumped: 2 });
    for (const id of [first.id, second.id]) {
      const after = await account(id);
      expect(after.authEpoch).toBe(before.authEpoch + 1);
      expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    }
    expect(await mappingFor(a.org.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(tenant)).toEqual({ orgId: b.org.id, partnerId: b.partner.id });
    const [row] = await audits(a.org.id, 'organization.portal_identity_proof.displaced');
    expect(row!.details).toEqual({ tenantId: tenant, displacedByOrgId: b.org.id, wasProven: true });
  });

  it('displacement leaves accounts without an identity in that tenant untouched (epoch unchanged)', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const c = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, provenByConnection());
    const inTenant = await seedAccount(a.org.id, tenant);
    const passwordOnly = await seedAccount(a.org.id, null);
    const otherTenant = await seedAccount(a.org.id, newTenant());
    // Same tenant, but in an org that is not being displaced.
    const elsewhere = await seedAccount(c.org.id, tenant);
    const untouched = [passwordOnly, otherTenant, elsewhere];
    const before = await Promise.all(untouched.map((u) => account(u.id)));

    const outcome = await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced?.epochsBumped).toBe(1);
    expect((await account(inTenant.id)).authEpoch).toBe(2);
    expect(await Promise.all(untouched.map((u) => account(u.id)))).toEqual(before);
  });

  it('m365_connection proof cannot displace a proven mapping (409 TENANT_PROVEN_ELSEWHERE)', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant, {
      via: 'proof_run', evidence: { via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() },
    });
    const victim = await seedAccount(a.org.id, tenant);

    const err = await proofError(recordEntraTenantProof(connectionProof(b.org.id, tenant, b.tech.id)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', httpStatus: 409 });

    expect(await mappingFor(a.org.id)).toMatchObject({ entraTenantId: tenant, provenVia: 'proof_run' });
    expect(await mappingFor(b.org.id)).toBeNull();
    expect((await account(victim.id)).authEpoch).toBe(1);
    expect(await audits(a.org.id, 'organization.portal_identity_proof.displaced')).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it('m365_connection proof displaces an unproven mapping', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);

    const outcome = await recordEntraTenantProof(connectionProof(b.org.id, tenant, b.tech.id));

    expect(outcome.displaced).toMatchObject({ orgId: a.org.id, wasProven: false });
    expect(await mappingFor(b.org.id)).toMatchObject({ provenVia: 'm365_connection' });
  });

  it("m365_connection proof uses the identity-bound tenant of the org's connection; no row → 422 NO_VERIFIED_CONNECTION", async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();

    const none = await proofError(proveEntraTenantFromM365Connection(org.id, tech.id));
    expect(none).toMatchObject({ code: 'PORTAL_ENTRA_NO_VERIFIED_CONNECTION', httpStatus: 422 });

    const connection = (values: Partial<typeof m365Connections.$inferInsert>) => ({
      orgId: org.id, userId: null, consentAttemptId: randomUUID(), clientId: randomUUID(), clientSecret: null,
      authMode: 'application-certificate' as const, vaultRef: 'akv://vault.example/test-certificate/version',
      credentialVersion: 'test-version', permissionManifestVersion: 1, status: 'active' as const,
      profile: 'customer-graph-read' as const, credentialDomain: 'customer-graph-read' as const,
      ...values,
    });
    // None of these is identity-first tenant evidence: a connection still
    // waiting for consent has no bound tenant, Exchange PowerShell is not one
    // of the Graph profiles the consent flow verifies, and a legacy-direct
    // connection's tenant was TYPED by the MSP (spec §5.4: never proof).
    await admin().insert(m365Connections).values([
      connection({ profile: 'customer-graph-actions', credentialDomain: 'customer-graph-actions', tenantId: null, status: 'pending-consent' }),
      connection({ profile: 'customer-exchange-powershell', credentialDomain: 'customer-exchange-powershell', tenantId: newTenant() }),
      connection({
        profile: 'legacy-direct', credentialDomain: 'legacy-direct', authMode: 'client-secret-legacy', tenantId: newTenant(),
        clientSecret: 'enc:v1:legacy-secret', vaultRef: null, credentialVersion: null, permissionManifestVersion: 0,
      }),
    ]);
    const stillNone = await proofError(proveEntraTenantFromM365Connection(org.id, tech.id));
    expect(stillNone.code).toBe('PORTAL_ENTRA_NO_VERIFIED_CONNECTION');
    expect(await getPortalEntraTenantStatus(org.id)).toEqual({
      tenantId: null, state: 'none', provenAt: null, provenVia: null, connectionTenantId: null,
    });

    const [bound] = await admin().insert(m365Connections).values(connection({ tenantId: tenant })).returning();
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ state: 'none', connectionTenantId: tenant });

    const outcome = await proveEntraTenantFromM365Connection(org.id, tech.id);

    expect(outcome).toEqual({ displaced: null, tenantId: tenant });
    expect(await mappingFor(org.id)).toMatchObject({
      entraTenantId: tenant,
      provenVia: 'm365_connection',
      provenByUserId: tech.id,
      provenEvidence: { via: 'm365_connection', connectionId: bound!.id, profile: 'customer-graph-read' },
    });
  });

  it('findOrgByProvenEntraTenant ignores unproven mappings', async () => {
    const { partner, org, tech } = await tenantOrg();
    const tenant = newTenant();
    await seedMapping(org.id, tenant);

    expect(await findOrgByProvenEntraTenant(tenant)).toBeNull();
    expect(await findProvenEntraTenantForOrg(org.id)).toBeNull();
    expect(await getPortalEntraTenantStatus(org.id)).toMatchObject({ tenantId: tenant, state: 'unproven', provenAt: null });

    await recordEntraTenantProof(proofRun(org.id, tenant, tech.id));
    expect(await findOrgByProvenEntraTenant(tenant)).toEqual({ orgId: org.id, partnerId: partner.id });
  });

  it('removePortalEntraTenant deletes the mapping and reports the tenant it held', async () => {
    const { org, tech } = await tenantOrg();
    const tenant = newTenant();
    await recordEntraTenantProof(proofRun(org.id, tenant, tech.id));

    expect(await removePortalEntraTenant(org.id)).toEqual({ removed: true, tenantId: tenant });
    expect(await mappingFor(org.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(tenant)).toBeNull();
    expect(await removePortalEntraTenant(org.id)).toEqual({ removed: false, tenantId: null });
  });

  it("displacement emails the displaced partner's active admins after commit; a send failure keeps the proof", async () => {
    const a = await tenantOrg('Contoso Ltd');
    const b = await tenantOrg();
    const adminOne = await partnerAdmin(a.partner.id);
    const adminTwo = await partnerAdmin(a.partner.id);
    await partnerAdmin(a.partner.id, { status: 'disabled' });
    await partnerAdmin(a.partner.id, { roleName: 'Technician' });
    await partnerAdmin(b.partner.id); // the proving partner is never told
    const tenant = newTenant();
    await seedMapping(a.org.id, tenant);
    // Inside the send, the proof must already be committed: the superuser
    // connection sees only committed rows.
    const seenFromSend: Array<string | null> = [];
    mail.onSend = async () => {
      const [row] = await mappingsForTenant(tenant);
      seenFromSend.push(row?.orgId ?? null);
    };

    await recordEntraTenantProof(proofRun(b.org.id, tenant, b.tech.id));

    expect(seenFromSend).toEqual([b.org.id]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]).toMatchObject({ partnerName: a.partner.name, orgName: 'Contoso Ltd', tenantId: tenant });
    expect([mail.sent[0]!.to].flat().sort()).toEqual([adminOne.email, adminTwo.email].sort());

    // A failing send never undoes the proof, and never surfaces to the caller.
    const c = await tenantOrg();
    const d = await tenantOrg();
    await partnerAdmin(c.partner.id);
    const tenantTwo = newTenant();
    await seedMapping(c.org.id, tenantTwo);
    mail.onSend = null;
    mail.fail = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const outcome = await recordEntraTenantProof(proofRun(d.org.id, tenantTwo, d.tech.id));

    expect(outcome.displaced).toMatchObject({ orgId: c.org.id });
    expect(await mappingFor(d.org.id)).toMatchObject({ entraTenantId: tenantTwo, provenVia: 'proof_run' });
    expect(await mappingFor(c.org.id)).toBeNull();
    expect(errorLog).toHaveBeenCalled();
  });

  it('a holding org is refused (409 PORTAL_ENTRA_PROTECTED_ORG) and nothing is written', async () => {
    const partner = await createPartner();
    const holding = await createOrganization({ partnerId: partner.id, type: 'unassigned_pool' });
    const tenant = newTenant();
    const err = await proofError(recordEntraTenantProof(proofRun(holding.id, tenant, null)));
    expect(err).toMatchObject({ code: 'PORTAL_ENTRA_PROTECTED_ORG', httpStatus: 409 });
    expect(await mappingsForTenant(tenant)).toHaveLength(0);
  });
});

/**
 * Review Focus 3 / D7: the advisory lock is taken before any read, so two
 * proofs of one fresh tenant serialize (FOR UPDATE alone locks nothing when no
 * row exists yet). The test holds that same lock on its own connection, starts
 * both proofs as separate promises on separate pooled connections, waits until
 * BOTH are queued behind it, and only then lets them go.
 */
describe('concurrent proofs of one fresh tenant', () => {
  const lockKey = (tenant: string) => `portal-entra-tenant:${tenant}`;

  async function waitersOn(tenant: string): Promise<number> {
    const rows = await admin().execute(sql`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND NOT granted AND objsubid = 1
         AND objid::bigint = (hashtext(${lockKey(tenant)})::bigint & 4294967295)`) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }

  /** Holds every tenant's lock until each has `waiters` proofs queued on it, then releases them together. */
  async function raceBehindLocks(waiters: Map<string, number>, inputs: RecordEntraProofInput[]) {
    let pending = null as Promise<PromiseSettledResult<unknown>[]> | null;
    await admin().transaction(async (tx) => {
      for (const tenant of waiters.keys()) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey(tenant)}))`);
      }
      pending = Promise.allSettled(inputs.map((input) => recordEntraTenantProof(input)));
      const deadline = Date.now() + 15_000;
      for (const [tenant, count] of waiters) {
        while ((await waitersOn(tenant)) < count) {
          if (Date.now() > deadline) throw new Error('the proofs never queued on the tenant advisory lock');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
    });
    return pending!;
  }

  const raceBehindLock = (tenant: string, inputs: RecordEntraProofInput[]) =>
    raceBehindLocks(new Map([[tenant, inputs.length]]), inputs);

  it('two orgs proving one fresh tenant concurrently: one proof, the other TENANT_PROVEN_ELSEWHERE', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();

    const results = await raceBehindLock(tenant, [
      connectionProof(a.org.id, tenant, a.tech.id),
      connectionProof(b.org.id, tenant, b.tech.id),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(PortalEntraProofError);
    expect(rejected[0]!.reason).toMatchObject({ code: 'PORTAL_ENTRA_TENANT_PROVEN_ELSEWHERE', httpStatus: 409 });

    const rows = await mappingsForTenant(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenVia).toBe('m365_connection');
    const winner = results[0]!.status === 'fulfilled' ? a.org.id : b.org.id;
    expect(rows[0]!.orgId).toBe(winner);
  });

  it('two concurrent proof runs of one fresh tenant: never a 500, one mapping, the later run displaces the earlier', async () => {
    const a = await tenantOrg();
    const b = await tenantOrg();
    const tenant = newTenant();

    const results = await raceBehindLock(tenant, [
      proofRun(a.org.id, tenant, a.tech.id),
      proofRun(b.org.id, tenant, b.tech.id),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const outcomes = results.map((r) => (r as PromiseFulfilledResult<{ displaced: { orgId: string } | null }>).value);
    // Exactly one of them ran second and displaced the other's fresh proof.
    expect(outcomes.filter((o) => o.displaced === null)).toHaveLength(1);
    const later = outcomes.find((o) => o.displaced !== null)!;
    const rows = await mappingsForTenant(tenant);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.orgId).not.toBe(later.displaced!.orgId);
    expect(later.displaced).toMatchObject({ wasProven: true });
  });

  // Different tenants take different advisory locks, so for one UNMAPPED org
  // both proofs can read "no own row" before either writes. The upsert must
  // then refuse, not silently repoint the first proof to the second tenant.
  it('one org proving two fresh tenants concurrently: one proof, the other ORG_HAS_OTHER_TENANT', async () => {
    const { org, tech } = await tenantOrg();
    const first = newTenant();
    const second = newTenant();

    const results = await raceBehindLocks(new Map([[first, 1], [second, 1]]), [
      proofRun(org.id, first, tech.id),
      proofRun(org.id, second, tech.id),
    ]);

    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'PORTAL_ENTRA_ORG_HAS_OTHER_TENANT', httpStatus: 409 });
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    expect(await mappingFor(org.id)).toMatchObject({ entraTenantId: winner, provenVia: 'proof_run' });
    expect(await audits(org.id, 'organization.portal_identity_proof.proven')).toHaveLength(1);
  });
});

describe('inv. 3 through the real AI for Office route', () => {
  it('the AI for Office PUT upsert to a new tenant leaves the mapping unproven', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    await admin().update(partners).set({ aiForOfficeEnabled: true }).where(eq(partners.id, env.partner.id));
    const token = await createAccessToken({
      sub: env.user.id, email: env.user.email, roleId: env.role.id, orgId: null, partnerId: env.partner.id,
      scope: 'partner', mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    });
    const app = new Hono();
    app.route('/client-ai/admin', clientAiAdminRoutes);
    const put = (entraTenantId: string) => app.request(`/client-ai/admin/orgs/${env.organization.id}/tenant-mapping`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ entraTenantId }),
    });
    const proven = newTenant();
    await recordEntraTenantProof(proofRun(env.organization.id, proven, env.user.id));

    // Re-saving the same tenant is not a repoint: the proof stays.
    expect((await put(proven)).status).toBe(200);
    expect(await findProvenEntraTenantForOrg(env.organization.id)).toMatchObject({ tenantId: proven });

    const typed = newTenant();
    expect((await put(typed)).status).toBe(200);

    expect(await mappingFor(env.organization.id)).toMatchObject({
      entraTenantId: typed, provenAt: null, provenVia: null, provenByUserId: null, provenEvidence: null,
    });
    expect(await findProvenEntraTenantForOrg(env.organization.id)).toBeNull();
    expect(await findOrgByProvenEntraTenant(typed)).toBeNull();
    expect(await findOrgByProvenEntraTenant(proven)).toBeNull();
  });
});

describe('org merge race (D8)', () => {
  let priorDrain: string | undefined;
  beforeEach(() => { priorDrain = process.env.ORG_MERGE_FENCE_DRAIN_MS; process.env.ORG_MERGE_FENCE_DRAIN_MS = '0'; });
  afterEach(() => { if (priorDrain === undefined) delete process.env.ORG_MERGE_FENCE_DRAIN_MS; else process.env.ORG_MERGE_FENCE_DRAIN_MS = priorDrain; });

  it('merge: a proof recorded between preview and execute is refused in Phase B (entra_tenant_conflict)', async () => {
    const partner = await createPartner();
    const loser = await createOrganization({ partnerId: partner.id });
    const survivor = await createOrganization({ partnerId: partner.id });
    const actor = await createUser({ partnerId: partner.id, email: `merge-${randomUUID()}@msp.test` });
    const loserTenant = newTenant();
    const survivorTenant = newTenant();
    await seedMapping(loser.id, loserTenant);
    await seedMapping(survivor.id, survivorTenant);

    const preview = await orgMergeModule.previewOrgMerge(loser.id, survivor.id, partner.id);
    expect(preview.blockerCodes).not.toContain('entra_tenant_conflict');

    // The proof lands after the pre-fence check passed: while the loser is
    // being fenced, before the Phase-B transaction opens.
    const realFence = orgMergeModule.fenceLoser;
    vi.spyOn(orgMergeModule, 'fenceLoser').mockImplementationOnce(async (candidate) => {
      await recordEntraTenantProof(proofRun(loser.id, loserTenant, actor.id));
      return realFence(candidate);
    });
    const assertSafe = vi.spyOn(orgMergeModule, 'assertMergeIsolationSafe');

    const error = await orgMergeModule.executeOrgMerge({
      loserOrgId: loser.id, survivorOrgId: survivor.id, partnerId: partner.id,
      performedBy: actor.id, performedByEmail: actor.email,
    }).then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(orgMergeModule.OrgMergeBlockedError);
    expect(error).toMatchObject({ blockerCodes: ['entra_tenant_conflict'] });
    expect(assertSafe).toHaveBeenCalledWith(loser.id, expect.any(Boolean), survivor.id);
    // Rolled back and unfenced: both mappings are where they were, the proof kept.
    expect(await mappingFor(loser.id)).toMatchObject({ entraTenantId: loserTenant, provenVia: 'proof_run' });
    expect(await mappingFor(survivor.id)).toMatchObject({ entraTenantId: survivorTenant, provenAt: null });
    const [org] = await admin().execute(sql`SELECT status FROM organizations WHERE id = ${loser.id}::uuid`) as unknown as Array<{ status: string }>;
    expect(org?.status).toBe('active');
  });
});
