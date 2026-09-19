import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn()
}));
vi.mock('../../hooks/useEventStream', () => ({
  useEventStream: () => ({ subscribe: vi.fn(), unsubscribe: vi.fn() })
}));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import NotificationCenter from './NotificationCenter';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  navigateMock.mockReset();
});

describe('NotificationCenter automation target path (#5288)', () => {
  it('routes an automation notification to /jobs, not /automations', async () => {
    fetchMock.mockResolvedValue(
      json({
        notifications: [
          {
            id: 'n1',
            type: 'automation',
            title: 'Nightly cleanup failed',
            message: 'Run failed',
            createdAt: '2026-09-10T00:00:00.000Z',
            read: true
          }
        ]
      })
    );

    render(<NotificationCenter />);

    const user = userEvent.setup();
    const trigger = await screen.findByRole('button', { name: /notifications/i });
    await user.click(trigger);

    const row = await screen.findByText('Nightly cleanup failed');
    await user.click(row);

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/jobs'));
  });
});
