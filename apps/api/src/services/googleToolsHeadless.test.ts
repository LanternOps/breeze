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
  GoogleConnectionUnavailableError,
  GOOGLE_HEADLESS_ACTIONS,
} from './googleToolsHeadless';

beforeEach(() => resolveMock.mockReset());

describe('googleToolsHeadless parity', () => {
  it('map covers EXACTLY the tier-3 googleToolTiers entries', () => {
    const tier3 = Object.entries(googleToolTiers).filter(([, t]) => t === 3).map(([n]) => n).sort();
    expect(Object.keys(GOOGLE_HEADLESS_ACTIONS).sort()).toEqual(tier3);
  });
  it('isHeadlessGoogleTool: true for a tier-3 tool, false for tier-1 and unknown', () => {
    expect(isHeadlessGoogleTool('google_suspend_user')).toBe(true);
    expect(isHeadlessGoogleTool('google_lookup_user')).toBe(false);
    expect(isHeadlessGoogleTool('m365_disable_user')).toBe(false);
    expect(isHeadlessGoogleTool('not_a_tool')).toBe(false);
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
