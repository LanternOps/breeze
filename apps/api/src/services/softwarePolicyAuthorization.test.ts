/**
 * #5505 D3 — arming `remediationOptions.autoInstall` installs software on
 * customer machines, which is exactly what creating a software deployment does
 * (`routes/software.ts:1882-1888`: devices:execute + requireMfa()). The
 * software-policy write routes carry only devices:write + requireMfa(), so
 * without this gate a devices:write holder reaches installation through the
 * policy route — a privilege-escalation path around the deployment gate.
 *
 * The check is over POST-WRITE state: stored row overlaid with the request
 * body. That is what makes "edit the rules of an ALREADY-armed policy" gated
 * too — adding a catalogId to an armed policy installs new software.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { mfaRef, executeRef } = vi.hoisted(() => ({
  mfaRef: { current: true },
  executeRef: { current: true },
}));

vi.mock('../middleware/auth', () => ({
  hasSatisfiedMfa: vi.fn(() => mfaRef.current),
}));

vi.mock('./permissions', () => ({
  PERMISSIONS: {
    DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },
  },
  hasPermission: vi.fn((_perms: unknown, resource: string, action: string) =>
    resource === 'devices' && action === 'execute' ? executeRef.current : false),
}));

import {
  ARM_INSTALL_EXECUTE_DENIED_MESSAGE,
  assertMayArmInstall,
  willBeArmedForInstall,
} from './softwarePolicyAuthorization';

const ARMED_STORED = { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } };
const UNARMED_STORED = { mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true } };

describe('willBeArmedForInstall — post-write merged state', () => {
  it('create: body alone arms', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    })).toBe(true);
  });

  it('create: enforceMode absent means not armed (the row is created with enforceMode=false)', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', remediationOptions: { autoInstall: true },
    })).toBe(false);
  });

  it('create: audit mode is never armed', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'audit', enforceMode: true, remediationOptions: { autoInstall: true },
    })).toBe(false);
  });

  it('create: autoUninstall does not arm install', () => {
    expect(willBeArmedForInstall(null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoUninstall: true },
    })).toBe(false);
  });

  it('update: an empty body over an ARMED stored row is still armed', () => {
    expect(willBeArmedForInstall(ARMED_STORED, {})).toBe(true);
  });

  it('update: an empty body over an UNARMED stored row is still unarmed', () => {
    expect(willBeArmedForInstall(UNARMED_STORED, {})).toBe(false);
  });

  it('update: the body wins over the stored row when it supplies the field', () => {
    expect(willBeArmedForInstall(ARMED_STORED, { remediationOptions: { autoInstall: false } })).toBe(false);
    expect(willBeArmedForInstall(ARMED_STORED, { enforceMode: false })).toBe(false);
    expect(willBeArmedForInstall(ARMED_STORED, { mode: 'audit' })).toBe(false);
    expect(willBeArmedForInstall(UNARMED_STORED, { remediationOptions: { autoInstall: true } })).toBe(true);
  });

  it('update: remediationOptions is REPLACED, not merged (routes/softwarePolicies.ts:556)', () => {
    // The stored row is armed; the body sends an options object without
    // autoInstall. The route writes that object wholesale, so the result is
    // disarmed — and the gate must agree.
    expect(willBeArmedForInstall(ARMED_STORED, { remediationOptions: { cooldownMinutes: 30 } })).toBe(false);
  });
});

/** Minimal Hono Context factory: runs a handler and hands back its Response. */
async function runGate(
  ctxSetup: (c: any) => void,
  stored: Parameters<typeof assertMayArmInstall>[1],
  patch: Parameters<typeof assertMayArmInstall>[2]
): Promise<Response> {
  const app = new Hono();
  app.get('/probe', async (c) => {
    ctxSetup(c);
    const denied = await assertMayArmInstall(c, stored, patch);
    return denied ?? c.json({ ok: true }, 200);
  });
  return app.request('/probe');
}

const ALLOWED_CTX = (c: any) => {
  c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } });
  c.set('permissions', { permissions: [], scope: 'organization', orgId: null, partnerId: null, roleId: 'role-1' });
};

describe('assertMayArmInstall', () => {
  beforeEach(() => {
    mfaRef.current = true;
    executeRef.current = true;
  });

  it('allows any write that does not arm install, regardless of permissions', async () => {
    executeRef.current = false;
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, UNARMED_STORED, { mode: 'allowlist' });
    expect(res.status).toBe(200);
  });

  it('allows an arming write from a caller with devices.execute and MFA', async () => {
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(200);
  });

  it('refuses an arming write without devices.execute', async () => {
    executeRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: ARM_INSTALL_EXECUTE_DENIED_MESSAGE,
      code: 'DEVICES_EXECUTE_REQUIRED',
    });
  });

  it('refuses an arming write when MFA is not satisfied, even with devices.execute', async () => {
    mfaRef.current = false;
    const res = await runGate(ALLOWED_CTX, null, {
      mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required', code: 'MFA_REQUIRED' });
  });

  it('fails closed when the route never resolved permissions', async () => {
    const res = await runGate(
      (c: any) => { c.set('auth', { user: { id: 'user-1' }, token: { mfa: true } }); },
      null,
      { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } }
    );
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('DEVICES_EXECUTE_REQUIRED');
  });

  it('refuses with 401 when there is no auth context at all', async () => {
    const res = await runGate(
      (c: any) => { c.set('permissions', { permissions: [] }); },
      null,
      { mode: 'allowlist', enforceMode: true, remediationOptions: { autoInstall: true } }
    );
    expect(res.status).toBe(401);
  });

  it('gates an edit that leaves an ALREADY-armed policy armed', async () => {
    executeRef.current = false;
    // Body touches only the name; the stored row stays armed for install.
    const res = await runGate(ALLOWED_CTX, ARMED_STORED, {});
    expect(res.status).toBe(403);
  });

  it('does not gate a write that DISARMS an armed policy', async () => {
    executeRef.current = false;
    const res = await runGate(ALLOWED_CTX, ARMED_STORED, { remediationOptions: { autoInstall: false } });
    expect(res.status).toBe(200);
  });
});
