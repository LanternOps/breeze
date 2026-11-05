/**
 * W08 (#9921) Task 8: /wisp is the home only where Wisp can run. Nothing is
 * decided while loading.
 *
 * W05 of #10131 (#10136): with the server flag off the page no longer forwards
 * to the chat — it shows the lock the sidebar shows ("Wisp runs on Breeze
 * Cloud…"), so nobody lands on a page called Wisp that is plain chat. An
 * org-scoped token (grants are partner-staff only) still goes to the Breeze AI
 * chat at /ai/chat.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  server: 'loading' as 'loading' | 'on' | 'off' | 'error',
  opts: undefined as undefined | { enabled?: boolean },
  claims: { status: 'resolved', claims: { scope: 'partner', partnerId: 'p-1', orgId: null } } as Record<string, unknown>,
}));
vi.mock('@/lib/wispVisibility', () => ({
  useWispServerState: (opts?: { enabled?: boolean }) => { h.opts = opts; return h.server; },
  useWispEnabled: () => h.server === 'on',
}));
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

  it('shows the server lock when Wisp is off, and never navigates away (W05 #10136, Review Focus 1)', () => {
    h.server = 'off';
    render(<WispHomePage />);
    expect(screen.getByTestId('wisp-home-server-lock')).toHaveAttribute('data-locked', 'true');
    expect(screen.getByTestId('wisp-home-server-lock-why')).toHaveTextContent(
      'Wisp runs on Breeze Cloud. It is not available on this server.',
    );
    // Nothing to buy on a self-hosted server: no upgrade link.
    expect(screen.queryByTestId('wisp-home-server-lock-cta')).toBeNull();
    expect(screen.queryByRole('link', { name: /upgrade/i })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Wisp' })).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByTestId('wisp-home-content-mock')).toBeNull();
    expect(screen.queryByTestId('wisp-home-loading')).toBeNull();
  });

  it('org-scoped token → the Breeze AI chat page even with the flag on (grants are partner-staff only; this server may well run Wisp)', () => {
    // The hook reads `off` without asking for a non-partner token; that is not
    // the server's answer, so it is not the server lock.
    h.server = 'off';
    h.claims = { status: 'resolved', claims: { scope: 'organization', partnerId: 'p-1', orgId: 'org-1' } };
    render(<WispHomePage />);
    expect(replace).toHaveBeenCalledWith('/ai/chat#session=abc');
    expect(screen.queryByTestId('wisp-home-server-lock')).toBeNull();
  });

  it('flag on + partner scope → the home', () => {
    h.server = 'on';
    render(<WispHomePage />);
    expect(screen.getByTestId('wisp-home-content-mock')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a failed server read is an error with reload, never a redirect that looks like "Wisp is off"', () => {
    h.server = 'error';
    render(<WispHomePage />);
    expect(screen.getByTestId('wisp-home-gate-error')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('asks the server only for a partner-scoped token', () => {
    h.claims = { status: 'resolved', claims: { scope: 'system', partnerId: null, orgId: null } };
    render(<WispHomePage />);
    expect(h.opts).toEqual({ enabled: false });
  });
});
