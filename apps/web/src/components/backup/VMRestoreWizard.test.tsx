import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import VMRestoreWizard from './VMRestoreWizard';
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

describe('VMRestoreWizard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/backup/snapshots') {
        return makeJsonResponse({
          data: [
            {
              id: 'snapshot-1',
              label: 'Nightly Snapshot',
              timestamp: '2026-03-28T10:00:00Z',
              sizeBytes: 2147483648,
            },
          ],
        });
      }
      if (url === '/devices') {
        return makeJsonResponse({
          data: [{ id: 'device-1', hostname: 'hyperv-01', osType: 'Windows Server 2022' }],
        });
      }
      return makeJsonResponse({});
    });
  });

  it('renders the first step for snapshot selection', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('Select backup snapshot');
    expect(screen.getByText('Nightly Snapshot')).toBeTruthy();
    expect(screen.getByText('1. Snapshot')).toBeTruthy();
  });

  it('renders alpha banner', async () => {
    render(<VMRestoreWizard />);

    await screen.findByText('VM Restore Wizard');
    expect(
      screen.getByText(/Restoring backups as Hyper-V VMs and Instant Boot are in early access/i)
    ).toBeTruthy();
  });
});
