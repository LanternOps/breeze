/**
 * W08 (#9921) Task 8: /wisp is the home only where Wisp can run. With the
 * server flag off, or for an org-scoped token (grants are partner-staff only),
 * the page hands over to /wisp/chat — the old /workspace page — so flag off is
 * no behaviour change beyond the URL. Nothing is decided while loading.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  server: 'loading' as 'loading' | 'on' | 'off',
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
}));
vi.mock('@/lib/wispVisibility', () => ({ useWispServerState: () => h.server, useWispEnabled: () => h.server === 'on' }));
vi.mock('@/lib/authScope', () => ({ useJwtClaims: () => h.claims }));
vi.mock('./WispHomeContent', () => ({ default: () => <div data-testid="wisp-home-content-mock" /> }));

import WispHomePage from './WispHomePage';

describe('WispHomePage gate (W08 Task 8)', () => {
  const replace = vi.fn();
  const original = window.location;

  beforeEach(() => {
    replace.mockReset();
    h.server = 'loading';
    h.claims = { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } };
    Object.defineProperty(window, 'location', { configurable: true, value: { ...original, hash: '#session=abc', pathname: '/wisp', replace } });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: original });
  });

  it('decides nothing while the server answer is pending', () => {
    render(<WispHomePage />);
    expect(screen.getByTestId('wisp-home-loading')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('server flag off → the chat page, keeping the fragment (old #session= links)', () => {
    h.server = 'off';
    render(<WispHomePage />);
    expect(replace).toHaveBeenCalledWith('/wisp/chat#session=abc');
    expect(screen.queryByTestId('wisp-home-content-mock')).toBeNull();
  });

  it('org-scoped token → the chat page even with the flag on', () => {
    h.server = 'on';
    h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    render(<WispHomePage />);
    expect(replace).toHaveBeenCalledWith('/wisp/chat#session=abc');
  });

  it('flag on + partner scope → the home', () => {
    h.server = 'on';
    render(<WispHomePage />);
    expect(screen.getByTestId('wisp-home-content-mock')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
