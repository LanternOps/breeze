/**
 * #8616 (heartbeat retain-state W02) — the real heartbeat route, real RLS
 * contexts, real PostgreSQL and Redis.
 *
 * A beat that advertises `securityCapabilities.retainStateProtocolVersion: 1`
 * and whose PAM decision could not be made gets `retainState: ['pam']` and no
 * `uacInterceptionEnabled` key. Every other beat gets the legacy payload,
 * byte for byte.
 *
 * The failure is forced by wrapping `buildPamConfigUpdate` in a hoisted
 * `vi.mock` (heartbeat.ts imports it as a named ESM import, which `vi.spyOn`
 * on the module namespace would not intercept). A mid-beat org move cannot be
 * reproduced deterministically, so the forced resolver failure is the
 * contract here; the unit suite covers the hierarchy-missing/error paths.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';

const pamFault = vi.hoisted(() => ({ remaining: 0 }));

vi.mock('../../routes/agents/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../routes/agents/helpers')>();
  return {
    ...actual,
    buildPamConfigUpdate: async (...args: Parameters<typeof actual.buildPamConfigUpdate>) => {
      if (pamFault.remaining > 0) {
        pamFault.remaining -= 1;
        throw new Error('forced pam resolver failure (#8616 integration test)');
      }
      return actual.buildPamConfigUpdate(...args);
    },
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { auditLogs, enrollmentKeys } from '../../db/schema';
import { createOrganization, createPartner, createSite } from './db-utils';
import { seedPolicy } from './policySetFixtures';
import { hashEnrollmentKey } from '../../services/enrollmentKeySecurity';
import { enrollmentRoutes } from '../../routes/agents/enrollment';
import { heartbeatRoutes } from '../../routes/agents/heartbeat';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function seedOrg(label: string) {
  const suffix = `${label}-${randomUUID()}`;
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const site = await createSite({ orgId: org.id });
  const rawKey = `retain-${suffix}`;
  await withSystemDbAccessContext(async () => {
    await db.insert(enrollmentKeys).values({
      orgId: org.id, siteId: site.id, name: `Retain ${label}`, key: hashEnrollmentKey(rawKey),
      keySecretHash: null, usageCount: 0, maxUsage: null, expiresAt: null,
    });
  });
  return { partnerId: partner.id, orgId: org.id, siteId: site.id, rawKey, suffix };
}
type SeededOrg = Awaited<ReturnType<typeof seedOrg>>;

/** Enroll writes its audit row fire-and-forget; wait for it so beats never race it. */
async function waitForEnrollAuditCommitted(deviceId: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: auditLogs.id }).from(auditLogs)
        .where(and(eq(auditLogs.action, 'agent.enroll'), eq(auditLogs.resourceId, deviceId))).limit(1),
    );
    if (rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`agent.enroll audit row for device ${deviceId} never became visible (10s)`);
}

async function enrollDevice(org: SeededOrg, hostname: string) {
  const app = new Hono();
  app.route('/agents', enrollmentRoutes);
  const response = await app.request('/agents/enroll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      enrollmentKey: org.rawKey, hostname: `${hostname}-${org.suffix}`, osType: 'windows',
      osVersion: 'Integration Windows', architecture: 'amd64', agentVersion: '1.0.0-test',
    }),
  });
  expect(response.status).toBe(201);
  const body = await response.json() as { deviceId: string; agentId: string };
  await waitForEnrollAuditCommitted(body.deviceId);
  return { deviceId: body.deviceId, agentId: body.agentId, orgId: org.orgId, siteId: org.siteId, partnerId: org.partnerId };
}
type EnrolledDevice = Awaited<ReturnType<typeof enrollDevice>>;

function agentApp(device: EnrolledDevice): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('agent', {
      deviceId: device.deviceId, agentId: device.agentId, orgId: device.orgId, siteId: device.siteId,
      partnerId: device.partnerId, role: 'agent', isPreAssignment: false,
    } as never);
    await next();
  });
  app.route('/agents', heartbeatRoutes);
  return app;
}

// What a current agent declares (compiledSecurityCapabilities() in
// agent/internal/heartbeat/heartbeat.go), minus the key under test.
const BASE_CAPABILITIES = {
  outboundNetworkPolicyVersion: 1,
  scriptSecretEnvVersion: 1,
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  revocationLeaseProtocolVersion: 1,
  desktopFenceProtocolVersion: 1,
  desktopWsFenceProtocolVersion: 1,
  consentPromptProtocolVersion: 2,
  pamLifetimeProtocolVersion: 2,
  pamReconciliation: { unresolvedCount: 0, quarantinedCount: 0, awaitingAcknowledgementCount: 0 },
};

/** `retain` undefined = the key is absent (a pre-W01 agent). */
async function beatRaw(device: EnrolledDevice, retain?: unknown): Promise<string> {
  const securityCapabilities = retain === undefined
    ? BASE_CAPABILITIES
    : { ...BASE_CAPABILITIES, retainStateProtocolVersion: retain };
  const response = await agentApp(device).request(`/agents/${device.agentId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'ok', agentVersion: '1.0.0-test', metricsAvailable: false, securityCapabilities }),
  });
  expect(response.status).toBe(200);
  return response.text();
}
async function beat(device: EnrolledDevice, retain?: unknown): Promise<Record<string, unknown>> {
  return JSON.parse(await beatRaw(device, retain)) as Record<string, unknown>;
}

async function forcedPamFailureBeatRaw(device: EnrolledDevice, retain?: unknown): Promise<string> {
  pamFault.remaining = 1;
  try {
    return await beatRaw(device, retain);
  } finally {
    // The fault must have been consumed by this beat's PAM resolution.
    expect(pamFault.remaining).toBe(0);
    pamFault.remaining = 0;
  }
}

/**
 * Baseline built the old way: captured from this test's forced-failure legacy
 * beat run against the pre-#8616 heartbeat (main at 338d6c304b). The keys the
 * retain-state builder now owns must keep their old values AND positions.
 */
const LEGACY_KEY_ORDER = [
  'commands', 'configUpdate', 'upgradeTo', 'manageRemoteManagement', 'manifestTrustKeys',
  'manifestKeyDelegations', 'uacInterceptionEnabled', 'helperEnabled', 'helperSettings',
];
const LEGACY_REMOTE_FRAGMENT = '"upgradeTo":null,"manageRemoteManagement":true,"manifestTrustKeys":[]';
const LEGACY_TAIL = '"manifestKeyDelegations":[],"uacInterceptionEnabled":false,"helperEnabled":false,'
  + '"helperSettings":{"enabled":false,"showOpenPortal":true,"showDeviceInfo":true,"showRequestSupport":true,"endpointMessaging":{"enabled":false}}}';

describe('heartbeat retainState (#8616) — real PostgreSQL', () => {
  afterEach(() => {
    pamFault.remaining = 0;
    vi.unstubAllEnvs();
  });

  runDb('PAM enabled by policy: a forced resolver failure retains pam for a v1 beat only; every other beat gets the legacy payload byte for byte', async () => {
    const org = await seedOrg('retain-on');
    const device = await enrollDevice(org, 'retain-on');
    await seedPolicy({
      owner: { orgId: org.orgId, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: true } }],
      assignments: [{ level: 'organization', targetId: org.orgId }],
    });

    // Happy v1 beat: the policy's decision, nothing retained.
    const happy = await beat(device, 1);
    expect(happy.uacInterceptionEnabled).toBe(true);
    expect('retainState' in happy).toBe(false);

    // (a) Forced failure + v1: retain pam, and ONLY pam (helper and remote
    // management resolved for real), with no uacInterceptionEnabled key.
    const retained = JSON.parse(await forcedPamFailureBeatRaw(device, 1)) as Record<string, unknown>;
    expect(retained.retainState).toEqual(['pam']);
    expect('uacInterceptionEnabled' in retained).toBe(false);
    expect(retained.helperEnabled).toBe(false);
    expect(retained.manageRemoteManagement).toBe(true);

    // (b) The same forced failure for a beat without the capability, and for
    // every value but exactly 1: the legacy payload, byte for byte.
    const legacyRaw = await forcedPamFailureBeatRaw(device);
    const legacy = JSON.parse(legacyRaw) as Record<string, unknown>;
    expect(legacy.uacInterceptionEnabled).toBe(false);
    expect('retainState' in legacy).toBe(false);
    expect(Object.keys(legacy)).toEqual(LEGACY_KEY_ORDER);
    expect(legacyRaw).toContain(LEGACY_REMOTE_FRAGMENT);
    expect(legacyRaw.endsWith(LEGACY_TAIL)).toBe(true);
    for (const other of [0, 2, -1, '1', true, 1.5, null]) {
      expect(await forcedPamFailureBeatRaw(device, other)).toBe(legacyRaw);
    }

    // Kill switch off: a v1 beat is answered exactly like a legacy one.
    vi.stubEnv('HEARTBEAT_RETAIN_STATE_ENABLED', 'false');
    expect(await forcedPamFailureBeatRaw(device, 1)).toBe(legacyRaw);
    vi.unstubAllEnvs();

    // (c) The next un-forced v1 beat carries the decision again.
    const recovered = await beat(device, 1);
    expect(recovered.uacInterceptionEnabled).toBe(true);
    expect('retainState' in recovered).toBe(false);
  });

  runDb('(d) PAM explicitly disabled by policy: a v1 beat gets uacInterceptionEnabled:false and nothing retained', async () => {
    const org = await seedOrg('retain-off');
    const device = await enrollDevice(org, 'retain-off');
    await seedPolicy({
      owner: { orgId: org.orgId, partnerId: null },
      links: [{ featureType: 'pam', inlineSettings: { uacInterceptionEnabled: false } }],
      assignments: [{ level: 'organization', targetId: org.orgId }],
    });

    const body = await beat(device, 1);
    expect(body.uacInterceptionEnabled).toBe(false);
    expect('retainState' in body).toBe(false);
  });
});
