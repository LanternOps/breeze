/**
 * Integration test — W13 PR B (#6783): manage_tenant_variables, manage_support_sessions and browse_device_event_log
 * honour the org axis, the site / device axes, the partner-wide gate and the never-a-secret rule against real
 * Postgres as the unprivileged `breeze_app` role.
 *
 * Entry point: `executeTool`, so the central `deviceArgs` gate runs before the handler as in production. The approval
 * step lives in the chat layer; this suite pins the CLASS each write is raised at and then tests what runs AFTER
 * approval, against stored rows:
 *   - tenant variables: a secret's plaintext never appears in any tool output or audit row; a secret row is never
 *     updated; a site-restricted caller cannot write; a partner-wide create needs canManagePartnerWidePolicies; an
 *     existing partner-wide row is never updated; another org's row is not found and survives a delete;
 *   - support sessions: only the caller partner's sessions are visible; another partner's session is not found and is
 *     never ended; org scope and restricted sessions are refused; an own session is ended;
 *   - event-log browse: an out-of-site or foreign device gets no device_commands row.
 * Every refusal has a CONTROL that lands the same call for the caller the guard admits. Nothing is stubbed and no
 * call here reaches a device (the in-site event-log control is an offline device, refused before dispatch).
 */
import './setup';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';

import type { DbAccessContext } from '../../db';
import { withDbAccessContext } from '../../db';
import { auditLogs, deviceCommands, devices, supportSessions, tenantVariables } from '../../db/schema';
import { executeTool } from '../../services/aiTools';
import { checkGuardrails } from '../../services/aiGuardrails';
import { clearPermissionCache } from '../../services/permissions';
import { decryptTenantVariableValue, encryptTenantVariableValue } from '../../services/tenantVariables';
import { getOrCreateQuickSupportOrg } from '../../services/quickSupportOrg';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const AI_SESSION_ID = randomUUID();
const SECRET = `w13b-secret-${randomUUID()}`;

function makeAuth(opts: {
  userId: string; partnerId: string; orgIds: string[]; scope?: 'organization' | 'partner';
  partnerOrgAccess?: 'all' | 'selected'; allowedSiteIds?: string[]; allowedDeviceIds?: string[];
}): AuthContext {
  const { allowedSiteIds, orgIds } = opts;
  const scope = opts.scope ?? 'organization';
  return {
    principal: { kind: 'user_session' },
    user: { id: opts.userId, email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    partnerId: opts.partnerId,
    orgId: scope === 'organization' ? orgIds[0]! : null,
    scope,
    partnerOrgAccess: opts.partnerOrgAccess,
    accessibleOrgIds: orgIds,
    orgCondition: (col: any) => inArray(col, orgIds),
    canAccessOrg: (id: string) => orgIds.includes(id),
    allowedSiteIds,
    allowedDeviceIds: opts.allowedDeviceIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
    aiOrigin: { kind: 'ai_assistant', sessionId: AI_SESSION_ID },
  } as unknown as AuthContext;
}

function ctxFor(auth: AuthContext): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const raw = await withDbAccessContext(ctxFor(auth), () => executeTool(tool, input, auth));
  return { raw, body: JSON.parse(raw) as Record<string, any> };
}

async function seedVariable(v: { orgId: string | null; partnerId: string | null; key: string; plaintext: string; isSecret: boolean }) {
  const id = randomUUID();
  await getTestDb().insert(tenantVariables).values({
    id, orgId: v.orgId, partnerId: v.partnerId, key: v.key, value: encryptTenantVariableValue(id, v.plaintext),
    isSecret: v.isSecret, version: 1,
  } as typeof tenantVariables.$inferInsert);
  return id;
}

const varRow = async (id: string) => (await getTestDb().select().from(tenantVariables).where(eq(tenantVariables.id, id)))[0];

interface Fixture {
  partnerId: string; otherPartnerId: string; orgA: string; orgB: string; userId: string; otherUserId: string;
  siteA: string; siteB: string; devA: string; devB: string; devOther: string;
  secretVar: string; plainVar: string; partnerVar: string; otherOrgVar: string;
  ownSession: string; otherSession: string;
  auth: {
    orgAdmin: AuthContext; restricted: AuthContext; otherOrg: AuthContext;
    partnerAll: AuthContext; partnerSel: AuthContext; partnerRestricted: AuthContext;
  };
}

async function seedSession(partnerId: string, userId: string): Promise<string> {
  const { orgId } = await getOrCreateQuickSupportOrg(partnerId);
  const now = Date.now();
  const [row] = await getTestDb().insert(supportSessions).values({
    orgId, createdByUserId: userId, codeHash: createHash('sha256').update(randomUUID()).digest('hex'),
    codeExpiresAt: new Date(now + 15 * 60_000), hardExpiresAt: new Date(now + 3_600_000), status: 'pending',
  } as typeof supportSessions.$inferInsert).returning({ id: supportSessions.id });
  return row!.id;
}

async function seedDevice(orgId: string, siteId: string, status: 'online' | 'offline' = 'online'): Promise<string> {
  const [row] = await getTestDb().insert(devices).values({
    orgId, siteId, agentId: `w13b-${randomUUID()}`, hostname: `w13b-${randomUUID().slice(0, 8)}`,
    osType: 'windows', osVersion: '11', architecture: 'x64', agentVersion: '1.0.0', status,
  }).returning({ id: devices.id });
  return row!.id;
}

async function seedFixture(): Promise<Fixture> {
  const partner = await createPartner();
  const otherPartner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });
  const siteA = await createSite({ orgId: orgA.id, name: 'W13b A' });
  const siteB = await createSite({ orgId: orgA.id, name: 'W13b B' });
  const siteOther = await createSite({ orgId: orgB.id, name: 'W13b other' });
  const user = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w13b-${randomUUID()}@example.com` });
  const otherOrgForOtherPartner = await createOrganization({ partnerId: otherPartner.id });
  const otherUser = await createUser({ partnerId: otherPartner.id, orgId: otherOrgForOtherPartner.id, email: `w13b-o-${randomUUID()}@example.com` });
  const base = { userId: user.id, partnerId: partner.id };
  // The partner's hidden Quick Support org is inside a partner session's accessibleOrgIds in production (it hangs off the partner).
  const { orgId: qsOrg } = await getOrCreateQuickSupportOrg(partner.id);
  return {
    partnerId: partner.id, otherPartnerId: otherPartner.id, orgA: orgA.id, orgB: orgB.id, userId: user.id, otherUserId: otherUser.id,
    siteA: siteA.id, siteB: siteB.id,
    devA: await seedDevice(orgA.id, siteA.id, 'offline'),
    devB: await seedDevice(orgA.id, siteB.id),
    devOther: await seedDevice(orgB.id, siteOther.id),
    secretVar: await seedVariable({ orgId: orgA.id, partnerId: null, key: 'db_password', plaintext: SECRET, isSecret: true }),
    plainVar: await seedVariable({ orgId: orgA.id, partnerId: null, key: 'api_base', plaintext: 'https://example.test', isSecret: false }),
    partnerVar: await seedVariable({ orgId: null, partnerId: partner.id, key: 'partner_wide', plaintext: 'pw-value', isSecret: false }),
    otherOrgVar: await seedVariable({ orgId: orgB.id, partnerId: null, key: 'other_org', plaintext: 'b-value', isSecret: false }),
    ownSession: await seedSession(partner.id, user.id),
    otherSession: await seedSession(otherPartner.id, otherUser.id),
    auth: {
      orgAdmin: makeAuth({ ...base, orgIds: [orgA.id] }),
      restricted: makeAuth({ ...base, orgIds: [orgA.id], allowedSiteIds: [siteA.id] }),
      otherOrg: makeAuth({ ...base, orgIds: [orgB.id] }),
      partnerAll: makeAuth({ ...base, orgIds: [orgA.id, orgB.id, qsOrg], scope: 'partner', partnerOrgAccess: 'all' }),
      partnerSel: makeAuth({ ...base, orgIds: [orgA.id], scope: 'partner', partnerOrgAccess: 'selected' }),
      partnerRestricted: makeAuth({ ...base, orgIds: [orgA.id, orgB.id, qsOrg], scope: 'partner', partnerOrgAccess: 'all', allowedSiteIds: [siteA.id] }),
    },
  };
}

let f: Fixture;
beforeEach(async () => {
  clearPermissionCache();
  f = await seedFixture();
});

describe('the class each write is raised at', () => {
  runDb('tenant-variable writes, event-log content reads and support-session end are supervised', () => {
    for (const action of ['create', 'update', 'delete']) {
      expect(checkGuardrails('manage_tenant_variables', { action })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    for (const action of ['query', 'get_event']) {
      expect(checkGuardrails('browse_device_event_log', { action })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
    }
    expect(checkGuardrails('browse_device_event_log', { action: 'list_logs' })).toMatchObject({ tier: 2 });
    expect(checkGuardrails('manage_support_sessions', { action: 'end' })).toMatchObject({ tier: 3, approvalScope: 'supervised' });
  });
});

describe('manage_tenant_variables', () => {
  runDb('a secret\'s plaintext never appears in list output (CONTROL: a plain value does)', async () => {
    const out = await run('manage_tenant_variables', { action: 'list' }, f.auth.orgAdmin);
    expect(out.raw).not.toContain(SECRET);
    const byKey = Object.fromEntries((out.body.variables as Array<{ key: string; value: unknown }>).map((v) => [v.key, v.value]));
    expect(byKey.db_password, out.raw).toBeNull();
    expect(byKey.api_base).toBe('https://example.test');
    expect(byKey.partner_wide).toBe('pw-value');
    expect(byKey.other_org).toBeUndefined();
  });

  runDb('a secret row is never updated, and deleting it leaks nothing into output or audit', async () => {
    const upd = await run('manage_tenant_variables', { action: 'update', variableId: f.secretVar, value: 'replaced-value-1234' }, f.auth.orgAdmin);
    expect(upd.body.code, upd.raw).toBe('ACCESS_DENIED');
    expect(decryptTenantVariableValue((await varRow(f.secretVar))!)).toBe(SECRET);

    const del = await run('manage_tenant_variables', { action: 'delete', variableId: f.secretVar }, f.auth.orgAdmin);
    expect(del.body.deleted, del.raw).toBe(true);
    expect(del.raw).not.toContain(SECRET);
    expect(await varRow(f.secretVar)).toBeUndefined();
    const audits = await getTestDb().select().from(auditLogs).where(eq(auditLogs.resourceId, f.secretVar));
    expect(JSON.stringify(audits)).not.toContain(SECRET);
  });

  runDb('a site-restricted caller cannot write (CONTROL: the org admin creates a plain variable for itself)', async () => {
    const refused = await run('manage_tenant_variables', { action: 'create', key: 'w13b_refused', value: 'v' }, f.auth.restricted);
    expect(refused.body.code, refused.raw).toBe('ACCESS_DENIED');
    const ok = await run('manage_tenant_variables', { action: 'create', key: 'w13b_created', value: 'v1' }, f.auth.orgAdmin);
    expect(ok.body.variable?.id, ok.raw).toBeTruthy();
    const rows = await getTestDb().select().from(tenantVariables).where(inArray(tenantVariables.key, ['w13b_refused', 'w13b_created']));
    expect(rows.map((r) => r.key)).toEqual(['w13b_created']);
    expect(rows[0]).toMatchObject({ orgId: f.orgA, isSecret: false, createdBy: f.userId });
  });

  runDb('a partner-wide create needs canManagePartnerWidePolicies; an existing partner-wide row is never updated', async () => {
    const sel = await run('manage_tenant_variables', { action: 'create', ownerScope: 'partner', key: 'w13b_pw_sel', value: 'v' }, f.auth.partnerSel);
    expect(sel.body.error, sel.raw).toBeTruthy();
    const all = await run('manage_tenant_variables', { action: 'create', ownerScope: 'partner', key: 'w13b_pw_all', value: 'v' }, f.auth.partnerAll);
    expect(all.body.variable?.id, all.raw).toBeTruthy();
    const rows = await getTestDb().select().from(tenantVariables).where(inArray(tenantVariables.key, ['w13b_pw_sel', 'w13b_pw_all']));
    expect(rows.map((r) => [r.key, r.orgId, r.partnerId])).toEqual([['w13b_pw_all', null, f.partnerId]]);

    const upd = await run('manage_tenant_variables', { action: 'update', variableId: f.partnerVar, value: 'changed' }, f.auth.partnerAll);
    expect(upd.body.code, upd.raw).toBe('ACCESS_DENIED');
    expect(decryptTenantVariableValue((await varRow(f.partnerVar))!)).toBe('pw-value');
  });

  runDb('another org\'s variable is not found and survives a delete (CONTROL: its own org deletes it)', async () => {
    const out = await run('manage_tenant_variables', { action: 'delete', variableId: f.otherOrgVar }, f.auth.orgAdmin);
    expect(out.body.code, out.raw).toBe('NOT_FOUND');
    expect(await varRow(f.otherOrgVar)).toBeDefined();
    const own = await run('manage_tenant_variables', { action: 'delete', variableId: f.otherOrgVar }, f.auth.otherOrg);
    expect(own.body.deleted, own.raw).toBe(true);
    expect(await varRow(f.otherOrgVar)).toBeUndefined();
  });
});

describe('manage_support_sessions', () => {
  const sessionRow = async (id: string) => (await getTestDb().select().from(supportSessions).where(eq(supportSessions.id, id)))[0]!;

  runDb('only the caller partner\'s sessions are listed; org scope and restricted sessions are refused', async () => {
    const list = await run('manage_support_sessions', { action: 'list' }, f.auth.partnerAll);
    const ids = (list.body.sessions as Array<{ id: string }>).map((s) => s.id);
    expect(ids, list.raw).toContain(f.ownSession);
    expect(ids).not.toContain(f.otherSession);
    expect(list.raw).not.toMatch(/codeHash|claimedFromIp/);
    for (const auth of [f.auth.orgAdmin, f.auth.partnerRestricted]) {
      const out = await run('manage_support_sessions', { action: 'list' }, auth);
      expect(out.body.code, out.raw).toBe('ACCESS_DENIED');
    }
  });

  runDb('another partner\'s session is not found and never ended (CONTROL: an own session ends)', async () => {
    const other = await run('manage_support_sessions', { action: 'end', sessionId: f.otherSession }, f.auth.partnerAll);
    expect(other.body.code, other.raw).toBe('NOT_FOUND');
    expect((await sessionRow(f.otherSession)).status).toBe('pending');

    const own = await run('manage_support_sessions', { action: 'end', sessionId: f.ownSession }, f.auth.partnerAll);
    expect(own.body.ended, own.raw).toBe(true);
    expect((await sessionRow(f.ownSession)).status).toBe('ended');
  });
});

describe('browse_device_event_log', () => {
  const commandsFor = (deviceId: string) => getTestDb().select().from(deviceCommands).where(eq(deviceCommands.deviceId, deviceId));

  runDb('an out-of-site or foreign device gets no command (CONTROL: an in-site offline device reaches the online check)', async () => {
    for (const deviceId of [f.devB, f.devOther]) {
      const out = await run('browse_device_event_log', { action: 'list_logs', deviceId }, f.auth.restricted);
      expect(out.body.error, out.raw).toBeTruthy();
      expect(out.body.code).not.toBe('DEVICE_OFFLINE');
      expect(await commandsFor(deviceId)).toHaveLength(0);
    }
    const inSite = await run('browse_device_event_log', { action: 'list_logs', deviceId: f.devA }, f.auth.restricted);
    expect(inSite.body.code, inSite.raw).toBe('DEVICE_OFFLINE');
    expect(await commandsFor(f.devA)).toHaveLength(0);
  });
});

