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

  it("refuses mode 'act' until that mode is supported", async () => {
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
    const body = await res.json() as { code: string };
    expect(body.code).toBe('mode_not_supported');
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

  it('refuses an unauthenticated request', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/ai/agents');
    expect(res.status).toBe(401);
  });
});
