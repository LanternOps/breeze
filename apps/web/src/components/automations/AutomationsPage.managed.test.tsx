import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));

import AutomationsPage from './AutomationsPage';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const automation = {
  id: 'automation-1',
  name: 'Triage critical alerts',
  orgId: 'org-1',
  enabled: true,
  trigger: { type: 'event', eventType: 'alert.triggered' },
  createdAt: '2026-08-24T12:00:00.000Z',
  updatedAt: '2026-08-24T12:00:00.000Z',
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe('AutomationsPage managed automation mapping', () => {
  it('carries managedByAgentId from the API response to the list badge', async () => {
    fetchMock.mockResolvedValue(
      json({ data: [{ ...automation, managedByAgentId: 'agent-1' }] }),
    );

    render(<AutomationsPage />);

    await waitFor(() =>
      expect(screen.getByTestId('automation-managed-by-agent-badge')).toBeInTheDocument(),
    );
  });

  it('does not badge an API row that omits managedByAgentId', async () => {
    fetchMock.mockResolvedValue(json({ data: [automation] }));

    render(<AutomationsPage />);

    await screen.findByText('Triage critical alerts');
    expect(screen.queryByTestId('automation-managed-by-agent-badge')).toBeNull();
  });
});
