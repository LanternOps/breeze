import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));
vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(() => ({ currentOrgId: 'org-1' })),
}));
vi.mock('@/hooks/useDefaultOwnerScope', () => ({
  useDefaultOwnerScope: () => ({ isPartnerScope: false, defaultOwnerScope: 'organization' }),
}));

import NotificationChannelsPage from './NotificationChannelsPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(json({ data: [] }));
});

describe('NotificationChannelsPage tab strip (#5288)', () => {
  it('renders the Monitoring strip when tabStrip="monitoring"', async () => {
    render(<NotificationChannelsPage tabStrip="monitoring" />);
    expect(await screen.findByRole('link', { name: 'Delivery' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByRole('link', { name: 'Correlations' })).toBeNull();
  });

  it('keeps the Alerts strip by default', async () => {
    render(<NotificationChannelsPage />);
    expect(await screen.findByRole('link', { name: 'Channels' })).toBeInTheDocument();
  });
});
