import './setup';

import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { aiAgentsRoutes } from '../../routes/aiAgents';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { partnerUsers } from '../../db/schema';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import {
  assignUserToOrganization,
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/ai/agents', aiAgentsRoutes);
  return app;
}

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

async function mfaClient(app: Hono, opts: {
  userId: string;
  email: string;
  roleId: string;
  orgId: string | null;
  partnerId: string | null;
  scope: 'organization' | 'partner' | 'system';
}) {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: opts.userId,
    email: opts.email,
    roleId: opts.roleId,
    orgId: opts.orgId,
    partnerId: opts.partnerId,
    scope: opts.scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  const token = await createAccessToken(payload);

  const makeRequest = (method: string, path: string, body?: unknown): Promise<Response> => {
    const requestOptions: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) requestOptions.body = JSON.stringify(body);
    // app.request() is typed Response | Promise<Response>.
    return Promise.resolve(app.request(path, requestOptions));
  };

  return {
    get: (path: string) => makeRequest('GET', path),
    post: (path: string, body?: unknown) => makeRequest('POST', path, body),
    patch: (path: string, body?: unknown) => makeRequest('PATCH', path, body),
    delete: (path: string) => makeRequest('DELETE', path),
  };
}

async function noMfaClient(app: Hono, opts: {
  userId: string; email: string; roleId: string;
  orgId: string | null; partnerId: string | null;
  scope: 'organization' | 'partner' | 'system';
}) {
  const token = await createAccessToken({
    sub: opts.userId, email: opts.email, roleId: opts.roleId,
    orgId: opts.orgId, partnerId: opts.partnerId, scope: opts.scope,
    mfa: false, aep: 1, mep: 1, sid: randomUUID(),
  } as Omit<TokenPayload, 'type'>);
  return {
    post: (path: string, body?: unknown): Promise<Response> =>
      Promise.resolve(app.request(path, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })),
  };
}

async function createSamePartnerClients(app: Hono) {
  const seeded = await createIntegrationTestClient(app, { scope: 'partner' });
  const { partner, organization, user, role } = seeded.env;

  const partnerAdmin = await mfaClient(app, {
    userId: user.id,
    email: user.email,
    roleId: role.id,
    orgId: null,
    partnerId: partner.id,
    scope: 'partner',
  });

  const orgUser = await createUser({
    partnerId: partner.id,
    orgId: organization.id,
  });
  const orgRole = await createRole({
    scope: 'organization',
    orgId: organization.id,
  });
  await grantRolePermissions(orgRole.id, [{ resource: '*', action: '*' }]);
  await assignUserToOrganization(orgUser.id, organization.id, orgRole.id);
  const orgAdmin = await mfaClient(app, {
    userId: orgUser.id,
    email: orgUser.email,
    roleId: orgRole.id,
    orgId: organization.id,
    partnerId: partner.id,
    scope: 'organization',
  });

  return { partnerAdmin, orgAdmin, env: seeded.env };
}

interface AgentJson {
  id: string;
  allOrgs: boolean;
  ownerScope: 'organization' | 'partner';
  disabledAt: string | null;
}

describe('/api/v1/ai/agents', () => {
  it('creates a partner-wide agent, hides it from org listings, and resolves it as the org baseline', async () => {
    const app = buildApp();
    const { partnerAdmin, orgAdmin, env } = await createSamePartnerClients(app);

    const createRes = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'triage',
      name: 'Triage',
      mode: 'shadow',
      enabled: true,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { data: AgentJson };
    expect(created.data.allOrgs).toBe(true);
    expect(created.data.ownerScope).toBe('partner');

    const listRes = await orgAdmin.get('/api/v1/ai/agents');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as { data: AgentJson[] };
    expect(listed.data.map((agent) => agent.id)).not.toContain(created.data.id);

    const effectiveRes = await orgAdmin.get(
      `/api/v1/ai/agents/effective?orgId=${env.organization.id}&kind=triage`,
    );
    expect(effectiveRes.status).toBe(200);
    const effective = await effectiveRes.json() as {
      data: { agentId: string; effective: { mode: string; enabled: boolean } };
    };
    expect(effective.data.agentId).toBe(created.data.id);
    expect(effective.data.effective.mode).toBe('shadow');
    // The global kill switch is unset in integration tests, so resolution fails closed.
    expect(effective.data.effective.enabled).toBe(false);
  });

  /**
   * Wave 4 Part B (#4148) flipped SUPPORTED_AGENT_MODES to ['off','shadow','act'],
   * so the pre-wave-4 contract this test used to assert — a bare
   * `mode_not_supported` refusal — no longer exists. The payload below is still
   * refused, but now by the act-ACTIVATION prerequisites
   * (assertActPrerequisites, agentService.ts): a row that will persist as
   * `mode: 'act'` needs at least one recipient that currently resolves to a
   * real user AND at least one act-eligible surface, and this payload declares
   * neither.
   *
   * Asserting `missing` rather than the code alone is what keeps this honest:
   * the two prerequisites are checked independently, so a regression that
   * dropped either one would still 422 on the survivor and slip past a
   * code-only assertion.
   */
  it("refuses mode 'act' when neither act prerequisite is met", async () => {
    const app = buildApp();
    const { partnerAdmin } = await createSamePartnerClients(app);

    const res = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'triage',
      name: 'Act agent',
      mode: 'act',
      enabled: true,
    });

    expect(res.status).toBe(422);
    const body = await res.json() as { code: string; missing: string[] };
    expect(body.code).toBe('act_prerequisites_not_met');
    expect([...body.missing].sort()).toEqual(['act_eligible_tool', 'recipient']);
  });

  it('lets an organization tighten a partner baseline to off', async () => {
    const app = buildApp();
    const { partnerAdmin, orgAdmin, env } = await createSamePartnerClients(app);

    const baselineRes = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'triage',
      name: 'Partner triage',
      mode: 'shadow',
      enabled: true,
    });
    expect(baselineRes.status).toBe(201);

    const overrideRes = await orgAdmin.post('/api/v1/ai/agents', {
      kind: 'triage',
      name: 'Org override',
      mode: 'off',
      orgId: env.organization.id,
    });
    expect(overrideRes.status).toBe(201);

    const effectiveRes = await orgAdmin.get(
      `/api/v1/ai/agents/effective?orgId=${env.organization.id}&kind=triage`,
    );
    expect(effectiveRes.status).toBe(200);
    const body = await effectiveRes.json() as {
      data: { effective: { mode: string }; provenance: { mode: string } };
    };
    expect(body.data.effective.mode).toBe('off');
    expect(body.data.provenance.mode).toBe('org');
  });

  it('refuses effective policy resolution for an inaccessible organization', async () => {
    const app = buildApp();
    const { orgAdmin } = await createSamePartnerClients(app);
    const foreignPartner = await createPartner();
    const foreignOrg = await createOrganization({ partnerId: foreignPartner.id });

    const res = await orgAdmin.get(
      `/api/v1/ai/agents/effective?orgId=${foreignOrg.id}&kind=triage`,
    );

    expect(res.status).toBe(403);
  });

  it('soft-disables an agent and only lists it when disabled rows are requested', async () => {
    const app = buildApp();
    const { partnerAdmin } = await createSamePartnerClients(app);

    const createRes = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'helpdesk',
      name: 'Helpdesk',
      mode: 'shadow',
      enabled: true,
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { data: AgentJson };

    const deleteRes = await partnerAdmin.delete(`/api/v1/ai/agents/${created.data.id}`);
    expect(deleteRes.status).toBe(200);
    const disabled = await deleteRes.json() as { data: AgentJson };
    expect(disabled.data.disabledAt).not.toBeNull();

    const activeRes = await partnerAdmin.get('/api/v1/ai/agents');
    expect(activeRes.status).toBe(200);
    const active = await activeRes.json() as { data: AgentJson[] };
    expect(active.data.map((agent) => agent.id)).not.toContain(created.data.id);

    const allRes = await partnerAdmin.get('/api/v1/ai/agents?includeDisabled=1');
    expect(allRes.status).toBe(200);
    const all = await allRes.json() as { data: AgentJson[] };
    expect(all.data.map((agent) => agent.id)).toContain(created.data.id);
  });

  it("denies partner-wide creation to a partner user with orgAccess='selected'", async () => {
    const app = buildApp();
    const { partnerAdmin, env } = await createSamePartnerClients(app);

    await withDbAccessContext(SYSTEM_CTX, () =>
      db
        .update(partnerUsers)
        .set({ orgAccess: 'selected', orgIds: [env.organization.id] })
        .where(eq(partnerUsers.userId, env.user.id)),
    );

    const res = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'triage',
      name: 'Selected access baseline',
      mode: 'shadow',
      enabled: true,
    });

    expect(res.status).toBe(403);
  });

  it('answers 409 instead of poisoning the transaction on a duplicate kind', async () => {
    // (owner, kind) is unique among active rows. The insert must never be the
    // thing that discovers that: a raised 23505 aborts the request-wide
    // withDbAccessContext transaction, and the COMMIT then 500s.
    const app = buildApp();
    const { partnerAdmin } = await createSamePartnerClients(app);

    const first = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'patch',
      name: 'Patch',
      mode: 'shadow',
    });
    expect(first.status).toBe(201);

    const second = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'patch',
      name: 'Patch again',
      mode: 'shadow',
    });
    expect(second.status).toBe(409);
    const body = await second.json() as { code: string };
    expect(body.code).toBe('agent_kind_exists');
  });

  it('PATCH preserves stored jsonb siblings the form never sends', async () => {
    // The settings form renders only alertSeverities/respectMaintenanceWindows
    // and services/paths/registryKeys. If a PATCH replaced those columns
    // wholesale, an agent's site/group/tag narrowing would vanish on the first
    // save — silently WIDENING its blast radius. Proven against real jsonb,
    // not a Drizzle mock.
    const app = buildApp();
    const { partnerAdmin, env } = await createSamePartnerClients(app);

    // Wave 3b validates recipients at write time (services/aiAgents/recipients.ts):
    // a made-up userId now 400s on create, so the fixture recipient must be a
    // real active member of the owning partner — the seeded partner admin.
    const recipientUserId = env.user.id;
    const created = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner',
      kind: 'triage',
      name: 'Narrowed triage',
      mode: 'shadow',
      triggers: {
        alertSeverities: ['critical'],
        siteIds: ['11111111-1111-4111-8111-111111111111'],
        deviceGroupIds: ['22222222-2222-4222-8222-222222222222'],
        deviceTags: ['prod'],
        respectMaintenanceWindows: true,
      },
      protectedResources: { services: ['sshd'], paths: ['/etc'], registryKeys: [], deviceTags: ['db'] },
      recipients: { userIds: [recipientUserId], roleIds: [] },
    });
    expect(created.status).toBe(201);
    const agentId = (await created.json() as { data: { id: string } }).data.id;

    const patched = await partnerAdmin.patch(`/api/v1/ai/agents/${agentId}`, {
      triggers: { alertSeverities: ['low'], respectMaintenanceWindows: false },
      protectedResources: { services: ['nginx'], paths: ['/var'], registryKeys: [] },
    });
    expect(patched.status).toBe(200);

    const reread = await partnerAdmin.get(`/api/v1/ai/agents/${agentId}`);
    expect(reread.status).toBe(200);
    const row = (await reread.json() as {
      data: {
        triggers: Record<string, unknown>;
        protectedResources: Record<string, unknown>;
        recipients: Record<string, unknown>;
      };
    }).data;

    // Sent keys changed…
    expect(row.triggers.alertSeverities).toEqual(['low']);
    expect(row.triggers.respectMaintenanceWindows).toBe(false);
    expect(row.protectedResources.services).toEqual(['nginx']);
    // …and every unsent sibling survived.
    expect(row.triggers.siteIds).toEqual(['11111111-1111-4111-8111-111111111111']);
    expect(row.triggers.deviceGroupIds).toEqual(['22222222-2222-4222-8222-222222222222']);
    expect(row.triggers.deviceTags).toEqual(['prod']);
    expect(row.protectedResources.deviceTags).toEqual(['db']);
    expect(row.recipients.userIds).toEqual([recipientUserId]);
  });

  it('answers 404 (never 500) for a non-uuid path id', async () => {
    // A raw id reaches Postgres as a uuid cast: 22P02 aborts the request-wide
    // transaction and the COMMIT then 500s on what is really a 404.
    const app = buildApp();
    const { partnerAdmin } = await createSamePartnerClients(app);

    for (const res of [
      await partnerAdmin.get('/api/v1/ai/agents/not-a-uuid'),
      await partnerAdmin.get('/api/v1/ai/agents/runs/not-a-uuid'),
      await partnerAdmin.delete('/api/v1/ai/agents/not-a-uuid'),
    ]) {
      expect(res.status).toBe(404);
    }
  });

  it('frees the kind slot on disable so the same kind can be recreated', async () => {
    // kind is immutable, so disable+recreate is the only way to change one. If
    // the create pre-check ever loses isNull(disabledAt) this 409s forever.
    const app = buildApp();
    const { partnerAdmin } = await createSamePartnerClients(app);

    const first = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner', kind: 'helpdesk', name: 'Helpdesk', mode: 'shadow',
    });
    expect(first.status).toBe(201);
    const id = (await first.json() as { data: { id: string } }).data.id;

    expect((await partnerAdmin.delete(`/api/v1/ai/agents/${id}`)).status).toBe(200);

    const recreated = await partnerAdmin.post('/api/v1/ai/agents', {
      ownerScope: 'partner', kind: 'helpdesk', name: 'Helpdesk again', mode: 'shadow',
    });
    expect(recreated.status).toBe(201);
  });

  it('refuses a write from a session that has not satisfied MFA', async () => {
    // Every other case here mints mfa:true, so requireMfa() could be deleted
    // from all three write routes with the suite still green.
    const app = buildApp();
    const seeded = await createIntegrationTestClient(app, { scope: 'partner' });
    const weak = await noMfaClient(app, {
      userId: seeded.env.user.id,
      email: seeded.env.user.email,
      roleId: seeded.env.role.id,
      orgId: null,
      partnerId: seeded.env.partner.id,
      scope: 'partner',
    });

    const res = await weak.post('/api/v1/ai/agents', {
      ownerScope: 'partner', kind: 'triage', name: 'No MFA', mode: 'shadow',
    });
    expect(res.status).toBe(403);
    expect((await res.json() as { code?: string }).code).toBe('MFA_REQUIRED');
  });

  it('refuses every read to a role holding organizations:* but not ai_agents:*', async () => {
    // The gate is a DEDICATED capability, not organizations:*. If these routes
    // ever slip back to ORGS_READ/ORGS_WRITE, every org admin silently regains
    // agent-authoring authority — which, once wave 4 enables `act`, is authority
    // over customer machines.
    const app = buildApp();
    const seeded = await createIntegrationTestClient(app, {
      scope: 'partner',
      rolePermissions: [
        { resource: 'organizations', action: 'read' },
        { resource: 'organizations', action: 'write' },
      ],
    });
    const orgOnly = await mfaClient(app, {
      userId: seeded.env.user.id,
      email: seeded.env.user.email,
      roleId: seeded.env.role.id,
      orgId: null,
      partnerId: seeded.env.partner.id,
      scope: 'partner',
    });

    expect((await orgOnly.get('/api/v1/ai/agents')).status).toBe(403);
    const res = await orgOnly.post('/api/v1/ai/agents', {
      ownerScope: 'partner', kind: 'triage', name: 'Org perms only', mode: 'shadow',
    });
    expect(res.status).toBe(403);
  });

  it('refuses a write from a role holding only ai_agents:read', async () => {
    const app = buildApp();
    const seeded = await createIntegrationTestClient(app, {
      scope: 'partner',
      rolePermissions: [{ resource: 'ai_agents', action: 'read' }],
    });
    const readOnly = await mfaClient(app, {
      userId: seeded.env.user.id,
      email: seeded.env.user.email,
      roleId: seeded.env.role.id,
      orgId: null,
      partnerId: seeded.env.partner.id,
      scope: 'partner',
    });

    expect((await readOnly.get('/api/v1/ai/agents')).status).toBe(200);
    const res = await readOnly.post('/api/v1/ai/agents', {
      ownerScope: 'partner', kind: 'triage', name: 'Read only', mode: 'shadow',
    });
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/ai/agents');
    expect(res.status).toBe(401);
  });
});
