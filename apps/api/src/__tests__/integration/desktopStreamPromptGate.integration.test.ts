/**
 * The WebSocket desktop fallback's prompt gate, against the real database.
 *
 * The relay's onOpen receives a device record built from the remote-WS
 * authorization context, which carries no capability fields. The gate must
 * read the device's consent prompt protocol version itself; otherwise every
 * start under a notify (the default) or consent policy reads as "agent cannot
 * show prompts" and is refused, however current the agent is.
 */
import { describe, expect, it } from 'vitest';

import './setup';
import { getTestDb } from './setup';
import { setupTestEnvironment } from './db-utils';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configPolicyRemoteAccessSettings,
  configurationPolicies,
  devices,
} from '../../db/schema';
import { resolveDesktopStreamPrompt } from '../../services/desktopStreamPromptGate';

const runDb = it.runIf(!!process.env.DATABASE_URL);

async function insertDevice(orgId: string, siteId: string, consentPromptProtocolVersion: number): Promise<string> {
  const agentId = `agent-ws-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const [row] = await getTestDb().insert(devices).values({
    orgId,
    siteId,
    agentId,
    hostname: `ws-prompt-${agentId}`,
    osType: 'macos',
    osVersion: '15',
    architecture: 'arm64',
    agentVersion: '0.0.0-test',
    status: 'online',
    consentPromptProtocolVersion,
    enrolledAt: new Date(),
  }).returning({ id: devices.id });
  return row!.id;
}

async function assignPromptMode(orgId: string, deviceId: string, mode: 'off' | 'notify' | 'consent'): Promise<void> {
  const db = getTestDb();
  const [policy] = await db.insert(configurationPolicies)
    .values({ orgId, name: `ws-prompt-${mode}-${Date.now()}`, status: 'active' })
    .returning({ id: configurationPolicies.id });
  const settings = {
    sessionPromptMode: mode,
    consentUnavailableBehavior: 'block',
    notifyOnSessionEnd: true,
    showActiveIndicator: true,
    technicianIdentityLevel: 'name_email',
  };
  const [link] = await db.insert(configPolicyFeatureLinks)
    .values({ configPolicyId: policy!.id, featureType: 'remote_access', inlineSettings: settings })
    .returning({ id: configPolicyFeatureLinks.id });
  await db.insert(configPolicyRemoteAccessSettings).values({ featureLinkId: link!.id, ...settings });
  await db.insert(configPolicyAssignments).values({ configPolicyId: policy!.id, level: 'device', targetId: deviceId });
}

describe('WebSocket desktop fallback prompt gate (real database)', () => {
  // The record onOpen receives on the upgrade path: identity only, no
  // capability fields.
  const asAuthorized = (id: string, orgId: string) => ({ id, orgId });

  runDb('a prompt-capable agent under the default policy (no policy → notify) gets the notify prompt', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await insertDevice(env.organization.id, env.site.id, 2);

    const decision = await resolveDesktopStreamPrompt(asAuthorized(deviceId, env.organization.id), env.user.id);

    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.prompt?.mode).toBe('notify');
  });

  runDb('a prompt-capable agent under a consent policy gets the consent prompt', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await insertDevice(env.organization.id, env.site.id, 1);
    await assignPromptMode(env.organization.id, deviceId, 'consent');

    const decision = await resolveDesktopStreamPrompt(asAuthorized(deviceId, env.organization.id), env.user.id);

    expect(decision.ok).toBe(true);
    expect(decision.ok && decision.prompt?.mode).toBe('consent');
  });

  runDb('an agent that cannot show prompts is refused under the default policy', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await insertDevice(env.organization.id, env.site.id, 0);

    await expect(
      resolveDesktopStreamPrompt(asAuthorized(deviceId, env.organization.id), env.user.id),
    ).resolves.toEqual({ ok: false, reason: 'consent_upgrade_required' });
  });

  runDb('an agent that cannot show prompts still starts when the policy shows none', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const deviceId = await insertDevice(env.organization.id, env.site.id, 0);
    await assignPromptMode(env.organization.id, deviceId, 'off');

    await expect(
      resolveDesktopStreamPrompt(asAuthorized(deviceId, env.organization.id), env.user.id),
    ).resolves.toEqual({ ok: true, prompt: undefined });
  });
});
