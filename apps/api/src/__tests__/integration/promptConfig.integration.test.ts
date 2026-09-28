/**
 * Integration test for Task 6 (remote-session consent feature):
 * `resolveRemoteSessionPromptConfig` resolution + technician identity redaction.
 *
 * Exercises the real effective-policy lookup against a real DB as the
 * unprivileged `breeze_app` role (the function resolves under system DB scope
 * via runOutsideDbContext → withSystemDbAccessContext). Seeds a partner / org /
 * site / device, a configuration policy with a `remote_access` feature link
 * carrying a `config_policy_remote_access_settings` row, and an assignment at
 * the device level, then asserts the resolved prompt config reflects the row.
 *
 * Also asserts the default path (no remote_access policy → spec defaults), the
 * refusal paths (unresolvable device; a remote_access link whose settings row
 * is missing although the link carries prompt settings), the VNC consent gate,
 * and the pure `buildTechnicianDisplay` redaction at each identity level.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import './setup';
import { getTestDb } from './setup';
import {
  partners,
  organizations,
  sites,
  devices,
  configurationPolicies,
  configPolicyFeatureLinks,
  configPolicyAssignments,
  configPolicyRemoteAccessSettings,
} from '../../db/schema';
import {
  resolveRemoteSessionPromptConfig,
  buildTechnicianDisplay,
  DEFAULT_REMOTE_SESSION_PROMPT_CONFIG,
} from '../../routes/remote/helpers';
import { RemoteSessionPromptPolicyError } from '../../routes/remote/consentGate';
import { checkVncConsentGate } from '../../routes/remote/vncConsentGate';

const hasDb = !!process.env.DATABASE_URL;

let orgId: string;
let siteId: string;

async function seedTenant(sfx: string): Promise<void> {
  const db = getTestDb();
  const [p] = await db
    .insert(partners)
    .values({ name: `PromptCfg ${sfx}`, slug: `promptcfg-${sfx}`, type: 'msp', plan: 'pro', status: 'active' })
    .returning({ id: partners.id });
  const [o] = await db
    .insert(organizations)
    .values({ currencyCode: 'USD', partnerId: p!.id, name: `PromptOrg ${sfx}`, slug: `promptorg-${sfx}` })
    .returning({ id: organizations.id });
  orgId = o!.id;
  const [s] = await db
    .insert(sites)
    .values({ orgId, name: `PromptSite ${sfx}` })
    .returning({ id: sites.id });
  siteId = s!.id;
}

async function seedDevice(sfx: string): Promise<string> {
  const db = getTestDb();
  const [d] = await db
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `pc-${sfx}`,
      hostname: `pc-${sfx}`,
      status: 'online',
      osType: 'linux',
      osVersion: '22.04',
      architecture: 'x86_64',
      agentVersion: '1.0.0',
    })
    .returning({ id: devices.id });
  return d!.id;
}

/**
 * Create an active config policy with a remote_access feature link carrying a
 * settings row, assigned to the device. Returns nothing — the device resolves
 * the policy through the inheritance chain.
 */
async function assignRemoteAccessPolicy(
  deviceId: string,
  sfx: string,
  settings: {
    sessionPromptMode: string;
    consentUnavailableBehavior?: string;
    notifyOnSessionEnd?: boolean;
    showActiveIndicator?: boolean;
    technicianIdentityLevel: string;
  },
  opts: { settingsRow?: boolean; linkInlineSettings?: Record<string, unknown> | null } = {},
): Promise<void> {
  const db = getTestDb();
  const [policy] = await db
    .insert(configurationPolicies)
    .values({ orgId, name: `RemoteAccessPolicy ${sfx}`, status: 'active' })
    .returning({ id: configurationPolicies.id });
  const [link] = await db
    .insert(configPolicyFeatureLinks)
    .values({
      configPolicyId: policy!.id,
      featureType: 'remote_access',
      inlineSettings: opts.linkInlineSettings === undefined ? settings : opts.linkInlineSettings,
    })
    .returning({ id: configPolicyFeatureLinks.id });
  if (opts.settingsRow !== false) await db.insert(configPolicyRemoteAccessSettings).values({
    featureLinkId: link!.id,
    sessionPromptMode: settings.sessionPromptMode,
    consentUnavailableBehavior: settings.consentUnavailableBehavior ?? 'proceed',
    notifyOnSessionEnd: settings.notifyOnSessionEnd ?? true,
    showActiveIndicator: settings.showActiveIndicator ?? true,
    technicianIdentityLevel: settings.technicianIdentityLevel,
  });
  await db.insert(configPolicyAssignments).values({
    configPolicyId: policy!.id,
    level: 'device',
    targetId: deviceId,
  });
}

describe('buildTechnicianDisplay (pure)', () => {
  it('redacts email at "name" level, keeping name + orgName', () => {
    expect(buildTechnicianDisplay('name', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: 'Jordan Lee',
      email: null,
      orgName: 'Acme',
    });
  });

  it('redacts name + email at "generic" level, keeping only orgName', () => {
    expect(buildTechnicianDisplay('generic', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: null,
      email: null,
      orgName: 'Acme',
    });
  });

  it('keeps everything at "name_email" level', () => {
    expect(buildTechnicianDisplay('name_email', 'Jordan Lee', 'j@acme.com', 'Acme')).toEqual({
      name: 'Jordan Lee',
      email: 'j@acme.com',
      orgName: 'Acme',
    });
  });
});

describe('resolveRemoteSessionPromptConfig', () => {
  beforeEach(async () => {
    if (!hasDb) return;
    await seedTenant(`${Date.now()}`);
  });

  it.runIf(hasDb)('resolves mode + identityLevel from an assigned remote_access policy', async () => {
    const sfx = `assigned-${Date.now()}`;
    const deviceId = await seedDevice(sfx);
    await assignRemoteAccessPolicy(deviceId, sfx, {
      sessionPromptMode: 'consent',
      consentUnavailableBehavior: 'block',
      notifyOnSessionEnd: false,
      showActiveIndicator: false,
      technicianIdentityLevel: 'name',
    });

    const cfg = await resolveRemoteSessionPromptConfig(deviceId);
    expect(cfg.mode).toBe('consent');
    expect(cfg.identityLevel).toBe('name');
    expect(cfg.consentUnavailableBehavior).toBe('block');
    expect(cfg.notifyOnEnd).toBe(false);
    expect(cfg.showIndicator).toBe(false);
  });

  it.runIf(hasDb)('returns spec defaults when no remote_access policy applies', async () => {
    const sfx = `default-${Date.now()}`;
    const deviceId = await seedDevice(sfx);

    const cfg = await resolveRemoteSessionPromptConfig(deviceId);
    expect(cfg).toEqual(DEFAULT_REMOTE_SESSION_PROMPT_CONFIG);
    expect(cfg.mode).toBe('notify');
    expect(cfg.identityLevel).toBe('name_email');
  });

  it.runIf(hasDb)('refuses (throws) instead of returning notify when the device does not resolve', async () => {
    await expect(resolveRemoteSessionPromptConfig('00000000-0000-4000-8000-000000000000'))
      .rejects.toBeInstanceOf(RemoteSessionPromptPolicyError);
  });

  it.runIf(hasDb)('refuses when the settings row is missing but the link carries prompt settings', async () => {
    const sfx = `missing-row-${Date.now()}`;
    const deviceId = await seedDevice(sfx);
    await assignRemoteAccessPolicy(deviceId, sfx, {
      sessionPromptMode: 'consent',
      consentUnavailableBehavior: 'block',
      technicianIdentityLevel: 'name',
    }, { settingsRow: false });

    await expect(resolveRemoteSessionPromptConfig(deviceId))
      .rejects.toThrow(/settings row missing/);
  });

  it.runIf(hasDb)('uses the stored-row defaults when a link saved without settings has no settings row', async () => {
    const sfx = `no-settings-${Date.now()}`;
    const deviceId = await seedDevice(sfx);
    await assignRemoteAccessPolicy(deviceId, sfx, {
      sessionPromptMode: 'notify',
      technicianIdentityLevel: 'name_email',
    }, { settingsRow: false, linkInlineSettings: null });

    const cfg = await resolveRemoteSessionPromptConfig(deviceId);
    expect(cfg).toEqual(DEFAULT_REMOTE_SESSION_PROMPT_CONFIG);
  });
});

describe('checkVncConsentGate (real policy resolution)', () => {
  beforeEach(async () => {
    if (!hasDb) return;
    await seedTenant(`vnc-${Date.now()}`);
  });

  it.runIf(hasDb)('refuses VNC for a device under a consent-mode policy', async () => {
    const sfx = `vnc-consent-${Date.now()}`;
    const deviceId = await seedDevice(sfx);
    await assignRemoteAccessPolicy(deviceId, sfx, {
      sessionPromptMode: 'consent',
      consentUnavailableBehavior: 'proceed',
      technicianIdentityLevel: 'name_email',
    });

    await expect(checkVncConsentGate(deviceId)).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { code: 'CONSENT_REQUIRED_TRANSPORT_UNAVAILABLE' },
    });
  });

  it.runIf(hasDb)('allows VNC for a notify-mode policy and for a device with no policy', async () => {
    const sfx = `vnc-notify-${Date.now()}`;
    const notifyDevice = await seedDevice(sfx);
    await assignRemoteAccessPolicy(notifyDevice, sfx, {
      sessionPromptMode: 'notify',
      technicianIdentityLevel: 'name_email',
    });
    const bareDevice = await seedDevice(`${sfx}-bare`);

    await expect(checkVncConsentGate(notifyDevice)).resolves.toEqual({ ok: true });
    await expect(checkVncConsentGate(bareDevice)).resolves.toEqual({ ok: true });
  });
});
