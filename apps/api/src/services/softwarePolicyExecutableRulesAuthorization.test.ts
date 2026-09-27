/**
 * #5480 moved PAM approval/policy authority to pam:approve / pam:manage_policy,
 * but software-policy writes were still gated only on devices:write. A policy's
 * rules.executable[] (sha256 / signer / publisher / pathGlob) in
 * mode:'allowlist' or 'blocklist' feeds PAM's auto-approve bridge directly, so
 * setting or changing those rules — or switching a rules-bearing policy's mode
 * — needs pam.manage_policy on top of devices.write.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { mfaRef, managePolicyRef } = vi.hoisted(() => ({
  mfaRef: { current: true },
  managePolicyRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));

vi.mock('./permissions', () => ({
  PERMISSIONS: {
    PAM_MANAGE_POLICY: { resource: 'pam', action: 'manage_policy' },
  },
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) =>
    resource === 'pam' && action === 'manage_policy' ? managePolicyRef.current : false),
}));

import {
  EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE,
  assertMayManageExecutableRules,
  willChangePamGovernedExecutableRules,
} from './softwarePolicyExecutableRulesAuthorization';

const EXEC_RULE = [{ name: 'evil.exe', pathGlob: 'C:\\Users\\*\\Downloads\\*' }];

describe('willChangePamGovernedExecutableRules', () => {
  it('create: allowlist policy with executable rules requires the gate', () => {
    expect(willChangePamGovernedExecutableRules(null, {
      mode: 'allowlist', executable: EXEC_RULE,
    })).toBe(true);
  });

  it('create: audit-mode policy with executable rules does not require the gate (no PAM effect)', () => {
    expect(willChangePamGovernedExecutableRules(null, {
      mode: 'audit', executable: EXEC_RULE,
    })).toBe(false);
  });

  it('create: allowlist policy with only software[] rules (no executable[]) does not require the gate', () => {
    expect(willChangePamGovernedExecutableRules(null, {
      mode: 'allowlist', executable: undefined,
    })).toBe(false);
  });

  it('update: adding executable rules to an existing allowlist policy requires the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'allowlist', executable: undefined },
      { mode: undefined, executable: EXEC_RULE }
    )).toBe(true);
  });

  it('update: changing an existing executable[] entry requires the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'allowlist', executable: EXEC_RULE },
      { mode: undefined, executable: [{ name: 'other.exe' }] }
    )).toBe(true);
  });

  it('update: re-sending the identical executable[] does not require the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'allowlist', executable: EXEC_RULE },
      { mode: undefined, executable: EXEC_RULE }
    )).toBe(false);
  });

  it('update: a write that never touches rules does not require the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'allowlist', executable: EXEC_RULE },
      { mode: undefined, executable: undefined }
    )).toBe(false);
  });

  it('update: switching mode on a policy carrying executable[] requires the gate, even with rules untouched', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'audit', executable: EXEC_RULE },
      { mode: 'allowlist', executable: undefined }
    )).toBe(true);
  });

  it('update: switching mode on a policy with only software[] rules does not require the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'audit', executable: undefined },
      { mode: 'allowlist', executable: undefined }
    )).toBe(false);
  });

  it('update: an unrelated field-only edit (name/description) does not require the gate', () => {
    expect(willChangePamGovernedExecutableRules(
      { mode: 'allowlist', executable: EXEC_RULE },
      {}
    )).toBe(false);
  });
});

async function runGate(
  ctxSetup: (c: any) => void,
  stored: Parameters<typeof assertMayManageExecutableRules>[1],
  patch: Parameters<typeof assertMayManageExecutableRules>[2]
): Promise<Response> {
  const app = new Hono();
  app.get('/probe', async (c) => {
    ctxSetup(c);
    const denied = await assertMayManageExecutableRules(c, stored, patch);
    return denied ?? c.json({ ok: true }, 200);
  });
  return app.request('/probe');
}

const ALLOWED_CTX = (c: any) => {
  c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } });
  c.set('permissions', { permissions: [], scope: 'organization', orgId: null, partnerId: null, roleId: 'role-1' });
};

describe('assertMayManageExecutableRules', () => {
  beforeEach(() => {
    mfaRef.current = true;
    managePolicyRef.current = true;
  });

  it('allows a non-governing write regardless of permissions', async () => {
    managePolicyRef.current = false;
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, { mode: 'audit', executable: EXEC_RULE });
    expect(res.status).toBe(200);
  });

  it('allows a governing write from a caller with pam.manage_policy and MFA', async () => {
    const res = await runGate(ALLOWED_CTX, null, { mode: 'allowlist', executable: EXEC_RULE });
    expect(res.status).toBe(200);
  });

  it('refuses a governing write without pam.manage_policy', async () => {
    managePolicyRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, { mode: 'allowlist', executable: EXEC_RULE });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE,
      code: 'PAM_MANAGE_POLICY_REQUIRED',
    });
  });

  it('refuses a governing write when MFA is not satisfied, even with pam.manage_policy', async () => {
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, { mode: 'allowlist', executable: EXEC_RULE });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
  });

  it('fails closed when the route never resolved permissions', async () => {
    const res = await runGate(
      (c: any) => { c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } }); },
      null,
      { mode: 'allowlist', executable: EXEC_RULE }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PAM_MANAGE_POLICY_REQUIRED');
  });

  it('refuses with 401 when there is no auth context at all', async () => {
    const res = await runGate(
      (c: any) => { c.set('permissions', { permissions: [] }); },
      null,
      { mode: 'allowlist', executable: EXEC_RULE }
    );
    expect(res.status).toBe(401);
  });
});
