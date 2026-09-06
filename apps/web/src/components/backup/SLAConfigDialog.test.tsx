import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import SLAConfigDialog from './SLAConfigDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown): Response => ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe('SLAConfigDialog device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => Promise.resolve(url.startsWith('/devices/options?')
      ? ok({ data: [{ id: 'd-99', hostname: 'zzz-sla-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }], page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' } })
      : ok({ data: [] })));
  });

  it('loads interactive choices from the authorized options endpoint', async () => {
    render(<SLAConfigDialog config={null} onClose={vi.fn()} />);
    expect(await screen.findByText('zzz-sla-device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });
});
