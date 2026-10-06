/**
 * Partner service principal keys (`brz_sp_`) on the MCP endpoint, end to end
 * against REAL Postgres (FORCE RLS as `breeze_app`) and real Redis.
 *
 * Drives the real `mcpServerRoutes` (mcpAuthMiddleware ->
 * partnerServicePrincipalMcpAuthMiddleware -> buildAuthFromApiKey -> tool
 * dispatch) with a raw key in X-API-Key, exactly as an MCP client sends it.
 *
 * Proves:
 *   - a principal with an MCP scope sees every org of its partner and nothing
 *     of another partner (app filter AND RLS);
 *   - a revoked/expired key, a disabled/expired principal, an inactive
 *     partner, a principal without an MCP scope, and an off-boarded or
 *     down-graded owner are all denied on the next request;
 *   - the principal's MCP scopes clamp what it can call;
 *   - Tier 3 stays MCP_APPROVAL_REQUIRED unless MCP_UNATTENDED_TIER3_PRINCIPALS
 *     names `partner_sp:<principal id>` (an `api_key:<key id>` entry never
 *     matches a principal key);
 *   - an ordinary org API key is unchanged (still pinned to its one org).
 *
 * Before this change every `brz_sp_` key on /api/v1/mcp fell through to the
 * org API-key middleware and was rejected 401 "Invalid API key", so every
 * positive assertion below fails on the old code.
 */
import './setup';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../../db';
import {
  aiSessions,
  aiToolExecutions,
  apiKeys,
  auditLogs,
  organizations,
  devices,
  partnerServicePrincipalKeys,
  partnerServicePrincipals,
  partnerUsers,
  partners,
  rolePermissions,
  users,
} from '../../db/schema';
import { clearPermissionCache } from '../../services/permissions';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const ALL_MCP_SCOPES = ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'];
const READ_ONLY_ROLE_PERMS = [
  { resource: 'organizations', action: 'read' },
  { resource: 'devices', action: 'read' },
  { resource: 'alerts', action: 'read' },
  { resource: 'scripts', action: 'read' },
  { resource: 'automations', action: 'read' },
];

let app: Hono;
let probe: Hono;

beforeAll(async () => {
  const { Hono: HonoCtor } = await import('hono');
  const { mcpServerRoutes } = await import('../../routes/mcpServer');
  const { partnerServicePrincipalMcpAuthMiddleware } = await import('../../middleware/partnerServicePrincipalMcpAuth');
  app = new HonoCtor();
  app.route('/api/v1/mcp', mcpServerRoutes);
  // RLS-only probe: the REAL middleware opens the request's DB context, then
  // the handler reads `organizations` with NO application filter at all, so
  // only Postgres RLS decides what is visible.
  probe = new HonoCtor();
  probe.get('/probe', partnerServicePrincipalMcpAuthMiddleware, async (c) => {
    const rows = await db.select({ id: organizations.id, partnerId: organizations.partnerId }).from(organizations);
    const [gucs] = await db.execute(sql`SELECT current_setting('breeze.user_id', true) AS user_id`) as unknown as Array<{ user_id: string | null }>;
    return c.json({ rows, userId: gucs?.user_id ?? null });
  });
});

afterEach(() => {
  delete process.env.MCP_UNATTENDED_TIER3_PRINCIPALS;
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function partnerOwner(partnerId: string, perms: Array<{ resource: string; action: string }> = [{ resource: '*', action: '*' }]) {
  const owner = await createUser({ partnerId, orgId: null, status: 'active', email: `owner-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, perms);
  const membership = await assignUserToPartner(owner.id, partnerId, role.id, 'all');
  return { owner, role, membership };
}

async function insertPrincipal(opts: {
  partnerId: string;
  ownerId: string;
  scopes: string[];
  status?: 'active' | 'disabled';
  expiresAt?: Date | null;
}) {
  const [row] = await getTestDb()
    .insert(partnerServicePrincipals)
    .values({
      partnerId: opts.partnerId,
      name: `claude-automation-${randomUUID()}`,
      status: opts.status ?? 'active',
      scopes: opts.scopes as never,
      expiresAt: opts.expiresAt ?? null,
      createdBy: opts.ownerId,
      updatedBy: opts.ownerId,
    })
    .returning();
  return row!;
}

async function insertKey(opts: {
  partnerId: string;
  principalId: string;
  createdBy: string;
  status?: 'active' | 'revoked';
  expiresAt?: Date | null;
}): Promise<{ rawKey: string; id: string }> {
  const rawKey = `brz_sp_${randomBytes(32).toString('base64url')}`;
  const [row] = await getTestDb()
    .insert(partnerServicePrincipalKeys)
    .values({
      partnerId: opts.partnerId,
      partnerServicePrincipalId: opts.principalId,
      name: `key-${randomUUID()}`,
      keyHash: sha256(rawKey),
      keyPrefix: rawKey.slice(0, 18),
      status: opts.status ?? 'active',
      expiresAt: opts.expiresAt ?? null,
      rateLimit: 10000,
      createdBy: opts.createdBy,
    })
    .returning();
  return { rawKey, id: row!.id };
}

/** A partner with two customer orgs, an owner (partner admin) and an MCP principal + key. */
async function partnerFixture(scopes: string[] = ALL_MCP_SCOPES) {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id, name: `SP-A-${randomUUID()}` });
  const orgB = await createOrganization({ partnerId: partner.id, name: `SP-B-${randomUUID()}` });
  const { owner, role, membership } = await partnerOwner(partner.id);
  const principal = await insertPrincipal({ partnerId: partner.id, ownerId: owner.id, scopes });
  const key = await insertKey({ partnerId: partner.id, principalId: principal.id, createdBy: owner.id });
  return { partner, orgA, orgB, owner, role, membership, principal, key };
}

let rpcId = 0;
async function mcp(rawKey: string, method: string, params?: Record<string, unknown>) {
  const res = await app.request('/api/v1/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': rawKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, ...(params ? { params } : {}) }),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function callTool(rawKey: string, name: string, args: Record<string, unknown> = {}) {
  return mcp(rawKey, 'tools/call', { name, arguments: args });
}

function toolText(body: any): string {
  return body?.result?.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '';
}

async function listedOrgNames(rawKey: string): Promise<string[]> {
  const res = await callTool(rawKey, 'list_organizations', { limit: 100 });
  expect(res.status).toBe(200);
  expect(res.body.error).toBeUndefined();
  const parsed = JSON.parse(toolText(res.body));
  return (parsed.organizations as Array<{ name: string }>).map((o) => o.name);
}

async function toolNames(rawKey: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const res = await mcp(rawKey, 'tools/list', cursor ? { cursor } : {});
    expect(res.status).toBe(200);
    for (const tool of res.body.result.tools as Array<{ name: string }>) names.push(tool.name);
    cursor = res.body.result.nextCursor;
    if (!cursor) break;
  }
  return names;
}

describe('partner service principal key on MCP: partner-wide reach', () => {
  it('sees every org of its partner and nothing from another partner', async () => {
    const p1 = await partnerFixture(['ai:read']);
    const p2 = await partnerFixture(['ai:read']);

    const seenByP1 = await listedOrgNames(p1.key.rawKey);
    expect(seenByP1).toEqual(expect.arrayContaining([p1.orgA.name, p1.orgB.name]));
    expect(seenByP1).not.toContain(p2.orgA.name);
    expect(seenByP1).not.toContain(p2.orgB.name);

    const seenByP2 = await listedOrgNames(p2.key.rawKey);
    expect(seenByP2).toEqual(expect.arrayContaining([p2.orgA.name, p2.orgB.name]));
    expect(seenByP2).not.toContain(p1.orgA.name);
  });

  it('RLS alone (no app filter) confines the key to its own partner, with no user id in the context', async () => {
    const p1 = await partnerFixture(['ai:read']);
    const p2 = await partnerFixture(['ai:read']);
    const res = await probe.request('/probe', { headers: { 'X-API-Key': p1.key.rawKey } });
    expect(res.status).toBe(200);
    const body = await res.json() as { rows: Array<{ id: string; partnerId: string }>; userId: string | null };
    const ids = body.rows.map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([p1.orgA.id, p1.orgB.id]));
    expect(ids).not.toContain(p2.orgA.id);
    expect(ids).not.toContain(p2.orgB.id);
    expect(body.rows.every((r) => r.partnerId === p1.partner.id)).toBe(true);
    expect(body.userId ?? '').toBe('');
  });

  it('a new org of the partner is reachable on the next request without re-keying', async () => {
    const p = await partnerFixture(['ai:read']);
    const later = await createOrganization({ partnerId: p.partner.id, name: `SP-late-${randomUUID()}` });
    expect(await listedOrgNames(p.key.rawKey)).toContain(later.name);
  });

  it('audits the request as the key, naming the partner service principal', async () => {
    const p = await partnerFixture(['ai:read']);
    await listedOrgNames(p.key.rawKey);

    let rows: Array<{ action: string; details: unknown }> = [];
    for (let attempt = 0; attempt < 40 && rows.length === 0; attempt += 1) {
      rows = await getTestDb()
        .select({ action: auditLogs.action, details: auditLogs.details })
        .from(auditLogs)
        .where(and(eq(auditLogs.actorId, p.key.id), eq(auditLogs.action, 'mcp.tools.call')));
      if (rows.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.details).toMatchObject({
      principalType: 'partner_service_principal',
      partnerServicePrincipalId: p.principal.id,
    });
  });
});

describe('partner service principal key on MCP: fail closed', () => {
  it('denies a revoked key, an expired key, and a disabled or expired principal; a rotated-in key works', async () => {
    const p = await partnerFixture(['ai:read']);
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(200);

    const replacement = await insertKey({ partnerId: p.partner.id, principalId: p.principal.id, createdBy: p.owner.id });
    await getTestDb().update(partnerServicePrincipalKeys)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(partnerServicePrincipalKeys.id, p.key.id));
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(401);
    expect((await mcp(replacement.rawKey, 'tools/list')).status).toBe(200);

    const expiredKey = await insertKey({
      partnerId: p.partner.id, principalId: p.principal.id, createdBy: p.owner.id,
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect((await mcp(expiredKey.rawKey, 'tools/list')).status).toBe(401);

    await getTestDb().update(partnerServicePrincipals)
      .set({ status: 'disabled' })
      .where(eq(partnerServicePrincipals.id, p.principal.id));
    expect((await mcp(replacement.rawKey, 'tools/list')).status).toBe(401);

    await getTestDb().update(partnerServicePrincipals)
      .set({ status: 'active', expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(partnerServicePrincipals.id, p.principal.id));
    expect((await mcp(replacement.rawKey, 'tools/list')).status).toBe(401);
  });

  it('denies when the partner is suspended', async () => {
    const p = await partnerFixture(['ai:read']);
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(200);
    await getTestDb().update(partners).set({ status: 'suspended' }).where(eq(partners.id, p.partner.id));
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(401);
  });

  it('refuses a principal that holds no MCP scope (Partner API scopes do not admit MCP)', async () => {
    const p = await partnerFixture(['devices:read', 'organizations:read']);
    const res = await mcp(p.key.rawKey, 'tools/list');
    expect(res.status).toBe(403);
  });

  it.each([['ai:write'], ['ai:execute'], ['ai:execute_admin']])('refuses a principal holding %s without ai:read, with a clear error', async (scope) => {
    // Inserted directly (the admin routes reject this shape) to prove the
    // auth path fails closed on any stored row that has it.
    const p = await partnerFixture([scope]);
    const res = await mcp(p.key.rawKey, 'tools/list');
    expect(res.status).toBe(403);
    expect(JSON.stringify(res.body)).toContain('require ai:read');
  });

  it('denies when the owner is disabled, removed from the partner, or reduced below the MCP scopes', async () => {
    const disabled = await partnerFixture(['ai:read']);
    expect((await mcp(disabled.key.rawKey, 'tools/list')).status).toBe(200);
    await getTestDb().update(users).set({ status: 'disabled' }).where(eq(users.id, disabled.owner.id));
    expect((await mcp(disabled.key.rawKey, 'tools/list')).status).toBe(401);

    const removed = await partnerFixture(['ai:read']);
    expect((await mcp(removed.key.rawKey, 'tools/list')).status).toBe(200);
    await getTestDb().delete(partnerUsers).where(eq(partnerUsers.id, removed.membership.id));
    await clearPermissionCache(removed.owner.id);
    expect((await mcp(removed.key.rawKey, 'tools/list')).status).toBe(401);

    // Owner keeps read-level permissions only: an ai:execute_admin principal
    // is denied outright, while an ai:read principal of the same owner works.
    const reduced = await partnerFixture(ALL_MCP_SCOPES);
    const readOnly = await insertPrincipal({ partnerId: reduced.partner.id, ownerId: reduced.owner.id, scopes: ['ai:read'] });
    const readOnlyKey = await insertKey({ partnerId: reduced.partner.id, principalId: readOnly.id, createdBy: reduced.owner.id });
    expect((await mcp(reduced.key.rawKey, 'tools/list')).status).toBe(200);
    await getTestDb().delete(rolePermissions).where(eq(rolePermissions.roleId, reduced.role.id));
    await grantRolePermissions(reduced.role.id, READ_ONLY_ROLE_PERMS);
    await clearPermissionCache(reduced.owner.id);
    expect((await mcp(reduced.key.rawKey, 'tools/list')).status).toBe(401);
    expect((await mcp(readOnlyKey.rawKey, 'tools/list')).status).toBe(200);
  });

  it('denies (never narrows) when the owner loses all-org access', async () => {
    const p = await partnerFixture(['ai:read']);
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(200);
    await getTestDb().update(partnerUsers)
      .set({ orgAccess: 'selected', orgIds: [p.orgA.id] })
      .where(eq(partnerUsers.id, p.membership.id));
    await clearPermissionCache(p.owner.id);
    expect((await mcp(p.key.rawKey, 'tools/list')).status).toBe(401);
  });

  it('an unknown well-formed brz_sp_ key is a 401', async () => {
    const res = await mcp(`brz_sp_${randomBytes(32).toString('base64url')}`, 'tools/list');
    expect(res.status).toBe(401);
  });
});

describe('partner service principal key on MCP: scope clamp', () => {
  it('an ai:read principal cannot call a write tool or a Tier 3 tool, even when listed as unattended', async () => {
    const p = await partnerFixture(['ai:read']);
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `partner_sp:${p.principal.id}`;

    const write = await callTool(p.key.rawKey, 'manage_organizations', {
      action: 'add_contact', orgId: p.orgA.id, name: 'x', email: 'x@example.test',
    });
    expect(JSON.stringify(write.body)).toMatch(/requires ai:(write|execute) scope/);

    const tier3 = await callTool(p.key.rawKey, 'execute_command', { deviceId: randomUUID(), commandType: 'list_processes' });
    expect(JSON.stringify(tier3.body)).toMatch(/requires ai:execute scope/);
  });
});

describe('partner service principal key on MCP: Tier 3 approval gate', () => {
  async function foreignDevice() {
    const other = await createPartner();
    const org = await createOrganization({ partnerId: other.id });
    const site = await createSite({ orgId: org.id });
    const [device] = await getTestDb().insert(devices).values({
      orgId: org.id, siteId: site.id, agentId: randomUUID(), hostname: `foreign-${randomUUID()}`,
      osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test',
    }).returning();
    return device!;
  }

  it('stays approval-only when the principal is not listed (and an api_key:<key id> entry does not match it)', async () => {
    const p = await partnerFixture();
    const device = await foreignDevice();

    expect(await toolNames(p.key.rawKey)).not.toContain('execute_command');
    const unlisted = await callTool(p.key.rawKey, 'execute_command', { deviceId: device.id, commandType: 'list_processes' });
    expect(toolText(unlisted.body)).toContain('MCP_APPROVAL_REQUIRED');

    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `api_key:${p.key.id}`;
    const wrongForm = await callTool(p.key.rawKey, 'execute_command', { deviceId: device.id, commandType: 'list_processes' });
    expect(toolText(wrongForm.body)).toContain('MCP_APPROVAL_REQUIRED');
  });

  it('is lifted for a principal listed as partner_sp:<id>, still confined to its own partner', async () => {
    const p = await partnerFixture();
    const device = await foreignDevice();
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `partner_sp:${p.principal.id.toUpperCase()}`;

    expect(await toolNames(p.key.rawKey)).toContain('execute_command');
    const res = await callTool(p.key.rawKey, 'execute_command', { deviceId: device.id, commandType: 'list_processes' });
    // Past the approval gate, scope gates and RBAC; the execution-org gate
    // then refuses another partner's device before any ledger or dispatch.
    expect(toolText(res.body)).not.toContain('MCP_APPROVAL_REQUIRED');
    expect(res.body.error).toMatchObject({ code: -32602, message: 'Invalid params' });

    // The per-tool limit was charged to the PRINCIPAL's own bucket, never the
    // owner's user id (which the owner's own sessions share).
    const { getRedis } = await import('../../services/redis');
    const redis = getRedis()!;
    expect(await redis.exists(`ai:tool:partner_sp:${p.principal.id}:execute_command`)).toBe(1);
    expect(await redis.exists(`ai:tool:${p.owner.id}:execute_command`)).toBe(0);
  });

  it('an own-partner Tier 3 call writes a ledger naming the principal, with no human session owner', async () => {
    const p = await partnerFixture();
    const site = await createSite({ orgId: p.orgA.id });
    const [device] = await getTestDb().insert(devices).values({
      orgId: p.orgA.id, siteId: site.id, agentId: randomUUID(), hostname: `own-${randomUUID()}`,
      osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test', status: 'offline',
    }).returning();
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `partner_sp:${p.principal.id}`;

    const res = await callTool(p.key.rawKey, 'execute_command', { deviceId: device!.id, commandType: 'list_processes' });
    expect(toolText(res.body)).not.toContain('MCP_APPROVAL_REQUIRED');
    // The offline device fails the call AFTER the ledger opened.
    expect(JSON.stringify(res.body)).toMatch(/not online/);

    const sessions = await getTestDb()
      .select({ id: aiSessions.id, userId: aiSessions.userId, orgId: aiSessions.orgId, snapshot: aiSessions.contextSnapshot })
      .from(aiSessions)
      .where(and(eq(aiSessions.orgId, p.orgA.id), eq(aiSessions.type, 'mcp')));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.userId).toBeNull();
    expect((sessions[0]!.snapshot as any).principal).toMatchObject({
      type: 'partner_service_principal',
      apiKeyId: p.key.id,
      partnerServicePrincipalId: p.principal.id,
      actorUserId: null,
    });
    const executions = await getTestDb()
      .select({ toolName: aiToolExecutions.toolName })
      .from(aiToolExecutions)
      .where(eq(aiToolExecutions.sessionId, sessions[0]!.id));
    expect(executions.map((e) => e.toolName)).toEqual(['execute_command']);
  });

  it('listing one principal does not lift another principal of the same partner', async () => {
    const p = await partnerFixture();
    const sibling = await insertPrincipal({ partnerId: p.partner.id, ownerId: p.owner.id, scopes: ALL_MCP_SCOPES });
    const siblingKey = await insertKey({ partnerId: p.partner.id, principalId: sibling.id, createdBy: p.owner.id });
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `partner_sp:${p.principal.id}`;

    expect(await toolNames(p.key.rawKey)).toContain('execute_command');
    expect(await toolNames(siblingKey.rawKey)).not.toContain('execute_command');
  });
});

describe('organization API key on MCP is unchanged', () => {
  it('an org key minted by the same partner admin still sees only its own org', async () => {
    const p = await partnerFixture(['ai:read']);
    const rawKey = `brz_${randomBytes(24).toString('hex')}`;
    await getTestDb().insert(apiKeys).values({
      orgId: p.orgA.id,
      createdBy: p.owner.id,
      name: `org-key-${randomUUID()}`,
      keyHash: sha256(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ['ai:read'],
      status: 'active',
    });

    const seen = await listedOrgNames(rawKey);
    expect(seen).toEqual([p.orgA.name]);
  });

  it('a product-shaped org key whose random part starts with sp_ still reaches the org-key path', async () => {
    // routes/apiKeys.ts mints `brz_` + 32 base64url chars, so a real org key
    // can read `brz_sp_` + 29 chars. It must never be routed as a partner key.
    const p = await partnerFixture(['ai:read']);
    const rawKey = `brz_sp_${randomBytes(32).toString('base64url').slice(0, 29)}`;
    expect(rawKey).toHaveLength(36);
    await getTestDb().insert(apiKeys).values({
      orgId: p.orgB.id,
      createdBy: p.owner.id,
      name: `org-key-sp-prefix-${randomUUID()}`,
      keyHash: sha256(rawKey),
      keyPrefix: rawKey.slice(0, 12),
      scopes: ['ai:read'],
      status: 'active',
    });

    expect(await listedOrgNames(rawKey)).toEqual([p.orgB.name]);
  });
});
