import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VaultDashboard from './VaultDashboard';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

describe('VaultDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  });

  it('renders loading state', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));

    render(<VaultDashboard />);

    expect(screen.getByText('Loading vaults...')).toBeTruthy();
  });

  it('renders empty state when no vaults exist', async () => {
    render(<VaultDashboard />);

    await screen.findByText('No vaults configured');
    expect(screen.getByText(/Add a local vault to enable on-site backup storage/i)).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<VaultDashboard />);

    await screen.findByText('Local Vaults');
    expect(screen.getByText(/Local vault \(SMB\/USB\) caching is in early access/i)).toBeTruthy();
  });
});
