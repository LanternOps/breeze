import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DRPlanEditor from './DRPlanEditor';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

describe('DRPlanEditor device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'd-99', hostname: 'zzz-dr-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' },
      }),
    } as unknown as Response);
  });

  it('lets each recovery group search authorized server options', async () => {
    render(<DRPlanEditor open planId={null} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(await screen.findByText('zzz-dr-device')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => /^\/devices(?:\?|$)/.test(String(url)))).toBe(false);
  });
});
