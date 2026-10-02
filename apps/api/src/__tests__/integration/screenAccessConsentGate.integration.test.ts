/**
 * Integration test: AI screen tools (take_screenshot, analyze_screen,
 * computer_control) and the device diagnose screenshot honour the device's
 * remote access consent policy, resolved against a real database as the
 * unprivileged `breeze_app` role.
 *
 * The tool handlers run inside an org-scoped `withDbAccessContext`, so the
 * policy is read under RLS as the caller (including the SELECT-only
 * partner-wide branch). Dispatch to the agent is mocked; the assertion is
 * whether it is reached. Refusals must leave a `screen_access_consent_blocked`
 * audit row; allowed calls must leave none.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './setup';

const { aiExecuteCommand } = vi.hoisted(() => ({ aiExecuteCommand: vi.fn() }));
vi.mock('../../services/aiDispatch', () => ({ aiExecuteCommand }));

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { withDbAccessContext, type DbAccessContext } from '../../db';
import { getTestDb } from './setup';
import {
  auditLogs,
  partners,
  organizations,
  sites,
  devices,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyRemoteAccessSettings,
} from '../../db/schema';
import { registerRemoteTools } from '../../services/aiToolsRemote';
import {
  checkScreenAccessConsentGate,
  SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION,
} from '../../routes/remote/screenAccessConsentGate';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../../services/aiTools';

const hasDb = !!process.env.DATABASE_URL;

let partnerId: string;
let orgId: string;
let siteId: string;

async function seedTenant(): Promise<void> {
  const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const db = getTestDb();
  const [p] = await db
    .insert(partners)
    .values({ name: `ScreenConsent ${sfx}`, slug: `screenconsent-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  partnerId = p!.id;
  const [o] = await db
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId, name: `ScreenOrg ${sfx}`, slug: `screenorg-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [s] = await db
    .insert(sites)
    .values({ orgId, name: `ScreenSite ${sfx}` })
    .returning({ id: sites.id });
  siteId = s!.id;
}

async function seedDevice(): Promise<string> {
  const sfx = randomUUID().slice(0, 8);
  const [d] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `screen-${sfx}`,
      hostname: `screen-${sfx}`,
      status: 'online',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x86_64',
      agentVersion: '1.0.0',
    })
    .returning({ id: devices.id });
  return d!.id;
}

async function assignPolicy(
  mode: 'off' | 'notify' | 'consent',
  target: { level: 'device'; deviceId: string } | { level: 'partner' },
): Promise<void> {
  const db = getTestDb();
  const settings = { sessionPromptMode: mode, consentUnavailableBehavior: 'proceed', technicianIdentityLevel: 'name' };
  const [policy] = await db
    .insert(configurationPolicies)
    .values(target.level === 'partner'
      ? { orgId: null, partnerId, name: `PartnerWide ${mode}`, status: 'active' }
      : { orgId, name: `Device ${mode}`, status: 'active' })
    .returning({ id: configurationPolicies.id });
  const [link] = await db
    .insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policy!.id, featureType: 'remote_access', inlineSettings: settings })
    .returning({ id: configPolicyFeatureLinks.id });
  await db.insert(configPolicyRemoteAccessSettings).values({ featureLinkId: link!.id, ...settings });
  await db.insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: target.level,
    targetId: target.level === 'partner' ? partnerId : target.deviceId,
  });
}

function orgContext(): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
}

function makeAuth(userId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'tech@example.com', name: 'Tech', isPlatformAdmin: false },
    token: {} as any,
    partnerId,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: (col: any) => eq(col, orgId),
    canAccessOrg: (id: string) => id === orgId,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: 'integration' },
  } as unknown as AuthContext;
}

function handler(name: string): AiTool['handler'] {
  const map = new Map<string, AiTool>();
  registerRemoteTools(map);
  return map.get(name)!.handler;
}

function inputFor(name: string, deviceId: string): Record<string, unknown> {
  return name === 'computer_control'
    ? { deviceId, action: 'left_click', x: 5, y: 5 }
    : { deviceId };
}

async function call(name: string, deviceId: string, userId: string): Promise<any> {
  const raw = await withDbAccessContext(orgContext(), () => handler(name)(inputFor(name, deviceId), makeAuth(userId)));
  return JSON.parse(raw);
}

async function refusalAudits(deviceId: string) {
  return getTestDb()
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.action, SCREEN_ACCESS_CONSENT_BLOCKED_AUDIT_ACTION), eq(auditLogs.resourceId, deviceId)));
}

const SCREEN_TOOLS = ['take_screenshot', 'analyze_screen', 'computer_control'] as const;

describe('AI screen tools under the remote access consent policy (real DB)', () => {
  beforeEach(async () => {
    aiExecuteCommand.mockReset();
    aiExecuteCommand.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ imageBase64: 'AA==', screenshot: { imageBase64: 'AA==' } }),
    });
    if (!hasDb) return;
    await seedTenant();
  });

  it.runIf(hasDb).each(SCREEN_TOOLS)('%s refuses and audits on a device-level consent policy', async (name) => {
    const deviceId = await seedDevice();
    await assignPolicy('consent', { level: 'device', deviceId });
    const userId = randomUUID();

    const result = await call(name, deviceId, userId);

    expect(result.code).toBe('CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE');
    expect(aiExecuteCommand).not.toHaveBeenCalled();
    const rows = await refusalAudits(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId,
      actorType: 'user',
      actorId: userId,
      resourceType: 'device',
      result: 'denied',
      initiatedBy: 'ai',
      details: { deviceId, surface: name, reason: 'prompt_unsupported', promptMode: 'consent' },
    });
  });

  it.runIf(hasDb)('refuses for an org-scoped caller when the consent policy is partner-wide', async () => {
    const deviceId = await seedDevice();
    await assignPolicy('consent', { level: 'partner' });

    const result = await call('computer_control', deviceId, randomUUID());

    expect(result.code).toBe('CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE');
    expect(aiExecuteCommand).not.toHaveBeenCalled();
    expect(await refusalAudits(deviceId)).toHaveLength(1);
  });

  it.runIf(hasDb)('dispatches unchanged under a notify policy and with no policy, without an audit row', async () => {
    const notifyDevice = await seedDevice();
    await assignPolicy('notify', { level: 'device', deviceId: notifyDevice });
    const bareDevice = await seedDevice();

    for (const deviceId of [notifyDevice, bareDevice]) {
      for (const name of SCREEN_TOOLS) {
        const result = await call(name, deviceId, randomUUID());
        expect(result.error, `${name} on ${deviceId}`).toBeUndefined();
      }
      expect(await refusalAudits(deviceId)).toHaveLength(0);
    }
    expect(aiExecuteCommand).toHaveBeenCalledTimes(SCREEN_TOOLS.length * 2);
  });

  it.runIf(hasDb)('the diagnose surface refuses from a context-less caller on a consent device', async () => {
    const deviceId = await seedDevice();
    await assignPolicy('consent', { level: 'device', deviceId });
    const userId = randomUUID();

    const gate = await checkScreenAccessConsentGate({
      deviceId,
      orgId,
      hostname: 'pc',
      surface: 'device_diagnose',
      actor: makeAuth(userId),
      isEphemeral: false,
    });

    expect(gate).toMatchObject({ ok: false, status: 409, body: { code: 'CONSENT_REQUIRED_SCREEN_ACCESS_UNAVAILABLE' } });
    const rows = await refusalAudits(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ initiatedBy: 'manual', details: { surface: 'device_diagnose' } });
  });

  it.runIf(hasDb)('refuses with REMOTE_PROMPT_POLICY_UNAVAILABLE when the caller cannot see the partner-wide policy', async () => {
    const deviceId = await seedDevice();
    await assignPolicy('consent', { level: 'partner' });

    // Same org, but without the caller's partner id the partner-wide branch
    // cannot fire, so the policy is unreadable rather than absent.
    const raw = await withDbAccessContext({ ...orgContext(), currentPartnerId: null }, () =>
      handler('take_screenshot')({ deviceId }, makeAuth(randomUUID())),
    );

    expect(JSON.parse(raw).code).toBe('REMOTE_PROMPT_POLICY_UNAVAILABLE');
    expect(aiExecuteCommand).not.toHaveBeenCalled();
    const rows = await refusalAudits(deviceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.details).toMatchObject({ reason: 'policy_unavailable', promptMode: null });
  });
});
