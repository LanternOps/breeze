/**
 * #8798: MCP pre-dispatch device-org resolution for tools that manage their
 * own DB context, against REAL Postgres (FORCE RLS as `breeze_app`).
 *
 * For a `tools/call` whose tool (or action) declares `selfManagedDbContext`,
 * the MCP auth middleware opens no request transaction. The pre-dispatch
 * resolver (`resolveMcpExecutionContext` -> `verifyDeviceAccess`) then read
 * `devices` with no RLS settings, saw nothing, and every such call failed
 * with -32602 "Invalid params" before reaching the tool, even for a device
 * the caller can access.
 *
 * `system_cleanup` is the cleanest probe: `list` is self-managed, `status` is
 * not, and both target a device. Each test uses an OFFLINE device, so a call
 * that gets through the resolver ends at the handler's own online check with
 * no agent dispatch.
 */
import './setup';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { devices, partnerServicePrincipalKeys, partnerServicePrincipals } from '../../db/schema';
import {
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
  userEpochs,
} from './db-utils';
import { getTestDb } from './setup';

const ALL_MCP_SCOPES = ['ai:read', 'ai:write', 'ai:execute', 'ai:execute_admin'];

let app: Hono;

beforeAll(async () => {
  const { Hono: HonoCtor } = await import('hono');
  const { mcpServerRoutes } = await import('../../routes/mcpServer');
  app = new HonoCtor();
  app.route('/api/v1/mcp', mcpServerRoutes);
});

afterEach(() => {
  delete process.env.MCP_UNATTENDED_TIER3_PRINCIPALS;
});

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** A partner with one org, a partner-admin owner, and an MCP principal key. */
async function partnerFixture() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id, name: `SMDB-${randomUUID()}` });
  const owner = await createUser({ partnerId: partner.id, orgId: null, status: 'active', email: `owner-${randomUUID()}@example.test` });
  const role = await createRole({ scope: 'partner', partnerId: partner.id });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  await assignUserToPartner(owner.id, partner.id, role.id, 'all');

  const [principal] = await getTestDb()
    .insert(partnerServicePrincipals)
    .values({
      partnerId: partner.id,
      name: `smdb-${randomUUID()}`,
      status: 'active',
      scopes: ALL_MCP_SCOPES as never,
      createdBy: owner.id,
      updatedBy: owner.id,
    })
    .returning();

  const rawKey = `brz_sp_${randomBytes(32).toString('base64url')}`;
  const epochs = await userEpochs(owner.id);
  await getTestDb().insert(partnerServicePrincipalKeys).values({
    partnerId: partner.id,
    partnerServicePrincipalId: principal!.id,
    name: `key-${randomUUID()}`,
    keyHash: sha256(rawKey),
    keyPrefix: rawKey.slice(0, 18),
    status: 'active',
    rateLimit: 10000,
    createdBy: owner.id,
    ownerCredentialEpoch: epochs.credentialEpoch,
    ownerMfaEpoch: epochs.mfaEpoch,
  });
  return { partner, org, principal: principal!, rawKey };
}

async function offlineDevice(orgId: string) {
  const site = await createSite({ orgId });
  const [device] = await getTestDb().insert(devices).values({
    orgId, siteId: site.id, agentId: randomUUID(), hostname: `smdb-${randomUUID()}`,
    osType: 'linux', osVersion: 'test', architecture: 'x86_64', agentVersion: 'test', status: 'offline',
  }).returning();
  return device!;
}

let rpcId = 0;
async function callTool(rawKey: string, name: string, args: Record<string, unknown>) {
  const res = await app.request('/api/v1/mcp/message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': rawKey },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<any>;
}

function toolText(body: any): string {
  return body?.result?.content?.map((c: { text?: string }) => c.text ?? '').join('') ?? '';
}

describe('MCP pre-dispatch for selfManagedDbContext device tools (#8798)', () => {
  it('control: a non-self-managed action on the same tool and device reaches the handler', async () => {
    const p = await partnerFixture();
    const device = await offlineDevice(p.org.id);

    const body = await callTool(p.rawKey, 'system_cleanup', {
      deviceId: device.id, action: 'status', cleanupRunId: randomUUID(),
    });
    expect(body.error).toBeUndefined();
    expect(toolText(body)).toContain('Cleanup run not found');
  });

  it('a self-managed action reaches the handler for an accessible device instead of -32602', async () => {
    const p = await partnerFixture();
    const device = await offlineDevice(p.org.id);

    const body = await callTool(p.rawKey, 'system_cleanup', {
      deviceId: device.id, action: 'list', commandId: randomUUID(),
    });
    expect(body.error).toBeUndefined();
    expect(toolText(body)).toMatch(/is not online/);
  });

  it('a self-managed Tier 3 tool (network_discovery) reaches the handler too', async () => {
    const p = await partnerFixture();
    const device = await offlineDevice(p.org.id);
    process.env.MCP_UNATTENDED_TIER3_PRINCIPALS = `partner_sp:${p.principal.id}`;

    const body = await callTool(p.rawKey, 'network_discovery', {
      deviceId: device.id, subnet: '10.0.0.0/24', scanType: 'ping',
    });
    expect(body.error).toBeUndefined();
    expect(JSON.stringify(body)).toMatch(/not online/);
  });

  it('still rejects another partner\'s device before dispatch', async () => {
    const p = await partnerFixture();
    const other = await createPartner();
    const otherOrg = await createOrganization({ partnerId: other.id });
    const foreign = await offlineDevice(otherOrg.id);

    const body = await callTool(p.rawKey, 'system_cleanup', {
      deviceId: foreign.id, action: 'list', commandId: randomUUID(),
    });
    expect(body.error).toMatchObject({ code: -32602, message: 'Invalid params' });
  });
});
