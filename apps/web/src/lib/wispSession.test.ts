/**
 * #10142: "no grant" (a server answer) must stay distinguishable from "no
 * answer" — a session created plain on a blip would be plain for good.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ scope: 'partner' as string | null, fetchWispThread: vi.fn() }));
vi.mock('./authScope', () => ({ getJwtClaims: () => ({ scope: h.scope, orgId: null, partnerId: 'p-1' }) }));
vi.mock('./wispGrant', () => ({ fetchWispThread: h.fetchWispThread }));

import { findActiveWispGrant, WispThreadError, wispSessionOrgId } from './wispSession';

const active = { grantId: 'g-1', status: 'active' };

describe('findActiveWispGrant', () => {
  beforeEach(() => {
    h.scope = 'partner';
    h.fetchWispThread.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('asks the org first, then partner-wide', async () => {
    h.fetchWispThread.mockRejectedValueOnce(new WispThreadError('none', 404)).mockResolvedValueOnce(active);
    await expect(findActiveWispGrant('org-a')).resolves.toEqual({ kind: 'grant', grant: active });
    expect(h.fetchWispThread.mock.calls).toEqual([['org-a'], [null]]);
  });

  it.each([404, 403, 402])('%i is a definitive "no grant"', async (status) => {
    h.fetchWispThread.mockRejectedValue(new WispThreadError('no', status));
    await expect(findActiveWispGrant('org-a')).resolves.toEqual({ kind: 'none' });
  });

  it.each([500, 503, 429, 408, null])('%s is no answer, and the partner-wide scope is not guessed past it', async (status) => {
    h.fetchWispThread.mockRejectedValue(new WispThreadError('down', status));
    await expect(findActiveWispGrant('org-a')).resolves.toEqual({ kind: 'unknown' });
    expect(h.fetchWispThread).toHaveBeenCalledTimes(1);
  });

  it('an untyped throw is no answer', async () => {
    h.fetchWispThread.mockRejectedValue(new Error('boom'));
    await expect(findActiveWispGrant(null)).resolves.toEqual({ kind: 'unknown' });
  });

  it('a non-partner token is never asked', async () => {
    h.scope = 'organization';
    await expect(findActiveWispGrant('org-a')).resolves.toEqual({ kind: 'none' });
    expect(h.fetchWispThread).not.toHaveBeenCalled();
  });
});

describe('wispSessionOrgId', () => {
  it('anchors to the focus org, else the grant org, else none', () => {
    expect(wispSessionOrgId({ focusOrgId: 'f', scopeOrgId: 's' })).toBe('f');
    expect(wispSessionOrgId({ focusOrgId: null, scopeOrgId: 's' })).toBe('s');
    expect(wispSessionOrgId({ focusOrgId: null, scopeOrgId: null })).toBeNull();
  });
});
