import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyLocale, i18n } from '@/lib/i18n';

import ProxyTunnelPage from './ProxyTunnelPage';
import { fetchWithAuth } from '@/stores/auth';

// #3632: `pollStatus` and `mintTicket` listed `t` in their useCallback deps, and
// each feeds an effect. A `languageChanged` (fired after hydration for every
// saved non-English locale) therefore restarted the status poll AND minted a
// fresh http-ticket, pointing the iframe at a new URL under a loaded session.
vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

const TUNNEL_ID = 'tunnel-123';
const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(body) }) as unknown as Response;

const mints = () =>
  fetchMock.mock.calls.filter(([url, opts]) => url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST').length;
const polls = () => fetchMock.mock.calls.filter(([url]) => url === `/tunnels/${TUNNEL_ID}`).length;

describe('ProxyTunnelPage: a locale change must not re-mint or restart polling', () => {
  beforeEach(async () => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url === `/tunnels/${TUNNEL_ID}/http-ticket` && opts?.method === 'POST') {
        return jsonRes({ ticket: { ticket: 'TKT-abc', expiresInSeconds: 300 } });
      }
      return jsonRes({ status: 'connecting' });
    });
    await act(() => i18n.changeLanguage('en'));
  });

  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('mints one ticket and polls once across a language change', async () => {
    const { container } = render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
    await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull());
    await waitFor(() => expect(polls()).toBe(1));
    expect(mints()).toBe(1);
    const src = container.querySelector('iframe')!.getAttribute('src');

    await act(async () => {
      await applyLocale('fr-FR');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The next scheduled poll is 5s away, so any extra call is an effect re-run.
    expect(mints()).toBe(1);
    expect(polls()).toBe(1);
    expect(container.querySelector('iframe')!.getAttribute('src')).toBe(src);
  });

  it('still re-mints when the tunnel actually changes', async () => {
    const { rerender } = render(<ProxyTunnelPage tunnelId={TUNNEL_ID} target="10.1.2.209:80" />);
    await waitFor(() => expect(mints()).toBe(1));
    rerender(<ProxyTunnelPage tunnelId="tunnel-456" target="10.1.2.209:80" />);
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/tunnels/tunnel-456/http-ticket', { method: 'POST' }),
    );
  });
});
