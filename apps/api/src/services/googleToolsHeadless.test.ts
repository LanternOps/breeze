import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveMock = vi.hoisted(() => vi.fn());
vi.mock('./aiToolsGoogle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./aiToolsGoogle')>();
  return { ...actual, resolveContextByOrg: resolveMock };
});

import { googleToolTiers } from './aiToolsGoogle';
import {
  isHeadlessGoogleTool,
  executeGoogleToolHeadless,
  executeGoogleSecretToolHeadless,
  GoogleConnectionUnavailableError,
  GOOGLE_HEADLESS_ACTIONS,
  GOOGLE_HEADLESS_SECRET_ACTIONS,
} from './googleToolsHeadless';

beforeEach(() => resolveMock.mockReset());

describe('googleToolsHeadless parity', () => {
  it('the union of GOOGLE_HEADLESS_ACTIONS and GOOGLE_HEADLESS_SECRET_ACTIONS covers EXACTLY the tier-3 googleToolTiers entries', () => {
    const headlessKeys = new Set([
      ...Object.keys(GOOGLE_HEADLESS_ACTIONS),
      ...Object.keys(GOOGLE_HEADLESS_SECRET_ACTIONS),
    ]);
    const tier3 = new Set(Object.entries(googleToolTiers).filter(([, t]) => t === 3).map(([k]) => k));
    expect(headlessKeys).toEqual(tier3);
  });
  it('isHeadlessGoogleTool: true for a tier-3 tool, false for tier-1 and unknown', () => {
    expect(isHeadlessGoogleTool('google_suspend_user')).toBe(true);
    expect(isHeadlessGoogleTool('google_lookup_user')).toBe(false);
    expect(isHeadlessGoogleTool('m365_disable_user')).toBe(false);
    expect(isHeadlessGoogleTool('not_a_tool')).toBe(false);
  });

  // Real (unmocked) assertion against the actual exported function — the
  // worker's own unit tests mock isHeadlessGoogleTool, so they cannot catch
  // a regression in this predicate (this exact class of bug broke the
  // durable google_reset_password release path after GOOGLE_HEADLESS_SECRET_ACTIONS
  // was split out of GOOGLE_HEADLESS_ACTIONS: isHeadlessGoogleTool tested
  // membership of the non-secret map only, so the worker's headless gate
  // failed session_required before ever reaching the invoke).
  it('isHeadlessGoogleTool: true for the secret-bearing google_reset_password tool', () => {
    expect(isHeadlessGoogleTool('google_reset_password')).toBe(true);
  });

  it('each key maps to its OWN correctly-named action fn (catches value mis-pairing)', () => {
    const EXCEPTIONS: Record<string, string> = {
      google_signout: 'googleSignOutAction',
      google_reset_2sv: 'googleResetTwoSvAction',
    };
    const toExpectedActionName = (key: string): string => {
      if (EXCEPTIONS[key]) return EXCEPTIONS[key];
      const rest = key.slice('google_'.length);
      const pascal = rest
        .split('_')
        .map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1))
        .join('');
      return `google${pascal}Action`;
    };
    for (const key of Object.keys(GOOGLE_HEADLESS_ACTIONS)) {
      const expectedName = toExpectedActionName(key);
      const action = GOOGLE_HEADLESS_ACTIONS[key];
      expect(action).toBeDefined();
      expect(action?.name).toBe(expectedName);
    }
    for (const key of Object.keys(GOOGLE_HEADLESS_SECRET_ACTIONS)) {
      const expectedName = toExpectedActionName(key);
      const action = GOOGLE_HEADLESS_SECRET_ACTIONS[key];
      expect(action).toBeDefined();
      expect(action?.name).toBe(expectedName);
    }
  });
});

describe('executeGoogleToolHeadless', () => {
  it('resolves by orgId and dispatches to the action fn', async () => {
    const fakeCtx = { conn: { adminEmail: 'a@x.com' }, keyJson: '{}' };
    resolveMock.mockResolvedValueOnce(fakeCtx);
    const spy = vi.spyOn(GOOGLE_HEADLESS_ACTIONS, 'google_suspend_user' as never)
      .mockResolvedValueOnce('Suspended Google Workspace user u@x.com.' as never);
    const out = await executeGoogleToolHeadless('google_suspend_user', { userEmail: 'u@x.com', reason: 'off' }, 'org-1');
    expect(resolveMock).toHaveBeenCalledWith('org-1');
    expect(spy).toHaveBeenCalledWith(fakeCtx, { userEmail: 'u@x.com', reason: 'off' });
    expect(out).toContain('Suspended');
  });
  it('throws GoogleConnectionUnavailableError when the connection cannot be resolved', async () => {
    resolveMock.mockResolvedValueOnce({ error: JSON.stringify({ error: 'no_google_connection', message: 'x' }) });
    await expect(
      executeGoogleToolHeadless('google_suspend_user', { userEmail: 'u@x.com', reason: 'off' }, 'org-1'),
    ).rejects.toBeInstanceOf(GoogleConnectionUnavailableError);
  });
  it('throws for a non-headless tool name (defensive; call site gates with isHeadlessGoogleTool)', async () => {
    await expect(executeGoogleToolHeadless('google_lookup_user', {}, 'org-1')).rejects.toThrow(/not a headless/i);
  });
});

// Mirrors the executeGoogleToolHeadless suite above — same three cases,
// against the secret-bearing counterpart. Nothing here exercised
// executeGoogleSecretToolHeadless directly before; only intentReleaseWorker.test.ts
// touched it, and only through a mock, so a regression in its connection-
// resolution or GoogleConnectionUnavailableError contract (e.g. returning
// `ctx.error` as a carrier instead of throwing) would have been caught by
// nothing in the repo.
describe('executeGoogleSecretToolHeadless', () => {
  it('resolves by orgId and dispatches to the secret action fn, returning its SecretToolResult carrier', async () => {
    const fakeCtx = { conn: { adminEmail: 'a@x.com' }, keyJson: '{}' };
    resolveMock.mockResolvedValueOnce(fakeCtx);
    const carrier = {
      kind: 'success' as const,
      llmText: 'Reset the password for u@x.com. The temporary credential is available for one-time reveal.',
      secrets: { temporaryPassword: 'unused-in-this-test' },
    };
    const spy = vi.spyOn(GOOGLE_HEADLESS_SECRET_ACTIONS, 'google_reset_password' as never)
      .mockResolvedValueOnce(carrier as never);
    const out = await executeGoogleSecretToolHeadless(
      'google_reset_password', { userEmail: 'u@x.com', reason: 'off' }, 'org-1',
    );
    expect(resolveMock).toHaveBeenCalledWith('org-1');
    expect(spy).toHaveBeenCalledWith(fakeCtx, { userEmail: 'u@x.com', reason: 'off' });
    expect(out).toBe(carrier);
  });

  it('throws GoogleConnectionUnavailableError when the connection cannot be resolved (never falls back to returning ctx.error as a carrier)', async () => {
    resolveMock.mockResolvedValueOnce({ error: JSON.stringify({ error: 'no_google_connection', message: 'x' }) });
    await expect(
      executeGoogleSecretToolHeadless('google_reset_password', { userEmail: 'u@x.com', reason: 'off' }, 'org-1'),
    ).rejects.toBeInstanceOf(GoogleConnectionUnavailableError);
  });

  it('throws for a non-secret-headless tool name (defensive; call site gates with GOOGLE_HEADLESS_SECRET_ACTIONS membership)', async () => {
    await expect(
      executeGoogleSecretToolHeadless('google_suspend_user', {}, 'org-1'),
    ).rejects.toThrow(/not a headless google secret tool/i);
  });
});
