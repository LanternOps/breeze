import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import SnapshotBrowser from './SnapshotBrowser';
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

describe('SnapshotBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      const method = (init as RequestInit | undefined)?.method ?? 'GET';

      if (url === '/backup/snapshots' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              id: 'snap-1',
              label: 'Nightly Snapshot',
              createdAt: '2026-03-31T00:00:00Z',
              sizeBytes: 1048576,
              fileCount: 5,
              location: 'snapshots/provider-snap-1',
              expiresAt: '2026-04-30T00:00:00Z',
              legalHold: false,
              legalHoldReason: null,
              isImmutable: false,
              immutableUntil: null,
              immutabilityEnforcement: null,
              requestedImmutabilityEnforcement: null,
              immutabilityFallbackReason: null,
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/browse' && method === 'GET') {
        return makeJsonResponse({
          data: [
            {
              name: 'Documents',
              path: '/Documents',
              type: 'directory',
              children: [
                {
                  name: 'report.txt',
                  path: '/Documents/report.txt',
                  type: 'file',
                  sizeBytes: 1234,
                },
              ],
            },
          ],
        });
      }

      if (url === '/backup/snapshots/snap-1/legal-hold' && method === 'POST') {
        return makeJsonResponse({
          id: 'snap-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-31T00:00:00Z',
          sizeBytes: 1048576,
          fileCount: 5,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: true,
          legalHoldReason: 'Litigation',
          isImmutable: false,
          immutableUntil: null,
          immutabilityEnforcement: null,
          requestedImmutabilityEnforcement: null,
          immutabilityFallbackReason: null,
        });
      }

      return makeJsonResponse({}, false, 404);
    });
  });

  it('renders snapshot protection details for the selected snapshot', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    expect(screen.getByText(/Protection Controls/i)).toBeTruthy();
    expect(screen.getByText(/Snapshot Details/i)).toBeTruthy();
    expect(screen.getByText(/Use the restore workflow to recover or export files from this snapshot/i)).toBeTruthy();
  });

  it('applies legal hold for the selected snapshot', async () => {
    render(<SnapshotBrowser />);

    await screen.findByText(/Protection Controls/i);
    fireEvent.change(screen.getByLabelText(/Reason/i), { target: { value: 'Litigation' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply legal hold/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/backup/snapshots/snap-1/legal-hold',
      expect.objectContaining({ method: 'POST' }),
    ));
    await screen.findByText(/Legal hold applied/i);
  });

  it('shows a fallback warning when provider immutability degrades to application protection', async () => {
    fetchMock.mockImplementationOnce(async () => makeJsonResponse({
      data: [
        {
          id: 'snap-1',
          label: 'Nightly Snapshot',
          createdAt: '2026-03-31T00:00:00Z',
          sizeBytes: 1048576,
          fileCount: 5,
          location: 'snapshots/provider-snap-1',
          expiresAt: '2026-04-30T00:00:00Z',
          legalHold: false,
          legalHoldReason: null,
          isImmutable: true,
          immutableUntil: '2026-04-30T00:00:00Z',
          immutabilityEnforcement: 'application',
          requestedImmutabilityEnforcement: 'provider',
          immutabilityFallbackReason: 'Bucket object lock no longer enabled',
        },
      ],
    }));

    render(<SnapshotBrowser />);

    expect(await screen.findByText(/Provider immutability was requested by policy/i)).toBeTruthy();
    expect(screen.getByText(/Bucket object lock no longer enabled/i)).toBeTruthy();
  });
});
