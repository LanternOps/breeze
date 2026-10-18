import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({
  db: { transaction: vi.fn(() => { throw new Error('db must not be reached'); }) },
}));

import {
  checkSecurityAgentsLinkWrite,
  SecurityAgentsLinkWriteError,
} from './securityAgentsLinkWrite';
import { addFeatureLink, updateFeatureLink } from '../configurationPolicy';

const DISABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: false }] };
const ENABLED = { version: 1, agents: [{ vendor: 'huntress', enabled: true }] };
const S1_ENABLED = { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }] };
const POLICY_ID = '22222222-2222-2222-2222-222222222222';

function code(input: Parameters<typeof checkSecurityAgentsLinkWrite>[0]) {
  const r = checkSecurityAgentsLinkWrite(input);
  return r.ok ? 'ok' : r.refusal.body.code;
}

describe('checkSecurityAgentsLinkWrite (#6960)', () => {
  it('checks arming authorization first, then featurePolicyId, then the schema, then enableable', () => {
    // Every later problem is present; the unauthorized caller only learns about the first.
    expect(code({ featurePolicyId: POLICY_ID, inlineSettings: { ...ENABLED, apiKey: 'x' }, armAuthorized: false }))
      .toBe('security_agents_execute_required');
    expect(code({ featurePolicyId: POLICY_ID, inlineSettings: { ...ENABLED, apiKey: 'x' }, armAuthorized: true }))
      .toBe('security_agents_feature_policy_not_allowed');
    expect(code({ featurePolicyId: null, inlineSettings: { ...ENABLED, apiKey: 'x' }, armAuthorized: true }))
      .toBe('security_agents_invalid_settings');
    expect(code({ featurePolicyId: null, inlineSettings: S1_ENABLED, armAuthorized: true }))
      .toBe('vendor_not_enableable');
  });

  it('Huntress is enableable with arming authority (W02)', () => {
    expect(code({ featurePolicyId: null, inlineSettings: ENABLED, armAuthorized: true })).toBe('ok');
  });

  it('an enabled vendor cannot be limited to a platform it does not support', () => {
    const r = checkSecurityAgentsLinkWrite({
      inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, platforms: ['windows', 'linux'] }] },
      armAuthorized: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.status).toBe(400);
      expect(r.refusal.body.code).toBe('security_agents_platform_unsupported');
      expect(r.refusal.body.vendors).toEqual(['huntress']);
    }
  });

  it('macOS (MDM approval) may be selected: those devices are shown not applicable, not refused', () => {
    expect(code({
      inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: true, platforms: ['windows', 'macos'] }] },
      armAuthorized: true,
    })).toBe('ok');
  });

  it('a disabled vendor is not checked for platforms', () => {
    expect(code({
      inlineSettings: { version: 1, agents: [{ vendor: 'huntress', enabled: false, platforms: ['linux'] }] },
      armAuthorized: false,
    })).toBe('ok');
  });

  it('allows disabled-only and empty settings without arming authority', () => {
    expect(code({ featurePolicyId: null, inlineSettings: DISABLED, armAuthorized: false })).toBe('ok');
    expect(code({ featurePolicyId: undefined, inlineSettings: { version: 1, agents: [] }, armAuthorized: false })).toBe('ok');
  });

  it('a PATCH that sends neither field passes; null settings are invalid', () => {
    expect(code({ armAuthorized: false })).toBe('ok');
    expect(code({ featurePolicyId: null, armAuthorized: false })).toBe('ok');
    expect(code({ inlineSettings: null, armAuthorized: true })).toBe('security_agents_invalid_settings');
  });

  it('every enabled vendor that is not enableable is refused, and the refusal names them all', () => {
    const r = checkSecurityAgentsLinkWrite({
      inlineSettings: { version: 1, agents: [{ vendor: 'sentinelone', enabled: true }, { vendor: 'huntress', enabled: true }, { vendor: 'nextdns', enabled: true }, { vendor: 'controld', enabled: false }] },
      armAuthorized: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.body.vendors).toEqual(['sentinelone', 'nextdns']);
  });
});

describe('service backstop: addFeatureLink / updateFeatureLink (#6960)', () => {
  it('addFeatureLink refuses enabled:true when the caller did not assert arming authority, before any DB access', async () => {
    await expect(addFeatureLink(POLICY_ID, 'security_agents', null, ENABLED))
      .rejects.toMatchObject({ code: 'security_agents_execute_required', status: 403 });
  });

  it('addFeatureLink refuses a featurePolicyId, unknown keys and missing settings', async () => {
    await expect(addFeatureLink(POLICY_ID, 'security_agents', POLICY_ID, DISABLED))
      .rejects.toBeInstanceOf(SecurityAgentsLinkWriteError);
    await expect(addFeatureLink(POLICY_ID, 'security_agents', null, { ...DISABLED, apiKey: 'x' }))
      .rejects.toMatchObject({ code: 'security_agents_invalid_settings' });
    await expect(addFeatureLink(POLICY_ID, 'security_agents', null, null))
      .rejects.toMatchObject({ code: 'security_agents_invalid_settings' });
  });

  it('addFeatureLink refuses a vendor that is not enableable even with arming authority', async () => {
    await expect(addFeatureLink(POLICY_ID, 'security_agents', null, S1_ENABLED, undefined, undefined, { securityAgentsArmAuthorized: true }))
      .rejects.toMatchObject({ code: 'vendor_not_enableable' });
  });

  it('addFeatureLink lets an authorized Huntress enable through to the write', async () => {
    await expect(addFeatureLink(POLICY_ID, 'security_agents', null, ENABLED, undefined, undefined, { securityAgentsArmAuthorized: true }))
      .rejects.toThrow('db must not be reached');
  });

  it('updateFeatureLink applies the same backstop inside its transaction', async () => {
    const existing = { id: 'link-1', configPolicyId: POLICY_ID, featureType: 'security_agents', featurePolicyId: null, inlineSettings: DISABLED };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      update: vi.fn(() => { throw new Error('must not write'); }),
    };
    const executor = { transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as any;
    await expect(updateFeatureLink('link-1', { inlineSettings: ENABLED }, POLICY_ID, undefined, executor))
      .rejects.toMatchObject({ code: 'security_agents_execute_required' });
    await expect(updateFeatureLink('link-1', { featurePolicyId: POLICY_ID }, POLICY_ID, undefined, executor))
      .rejects.toMatchObject({ code: 'security_agents_feature_policy_not_allowed' });
    expect(tx.update).not.toHaveBeenCalled();
  });
});
