import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PatchApprovalModal from './PatchApprovalModal';
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

describe('PatchApprovalModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ id: 'patch-1', status: 'deferred' }));
  });

  it('sends deferUntil when deferring a patch', async () => {
    const deferUntilLocal = '2026-04-08T09:00';

    render(
      <PatchApprovalModal
        open
        patch={{
          id: 'patch-1',
          title: 'Security Update',
          severity: 'critical',
          source: 'Microsoft',
          os: 'Windows',
          releaseDate: '2026-04-01T00:00:00.000Z',
          approvalStatus: 'pending',
        }}
        ringId="ring-1"
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Defer/i }));
    fireEvent.change(screen.getByLabelText(/Defer Until/i), {
      target: { value: deferUntilLocal },
    });
    fireEvent.click(screen.getAllByRole('button', { name: /Defer/i }).at(-1)!);

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/patch-1/defer',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            note: '',
            ringId: 'ring-1',
            deferUntil: new Date(deferUntilLocal).toISOString(),
          }),
        })
      )
    );
  });

  it('surfaces backend approval errors instead of a generic message', async () => {
    fetchMock.mockResolvedValueOnce(makeJsonResponse({ error: 'Ring access denied' }, false, 403));

    render(
      <PatchApprovalModal
        open
        patch={{
          id: 'patch-1',
          title: 'Security Update',
          severity: 'critical',
          source: 'Microsoft',
          os: 'Windows',
          releaseDate: '2026-04-01T00:00:00.000Z',
          approvalStatus: 'pending',
        }}
        ringId="ring-1"
        onClose={() => {}}
      />
    );

    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i }).at(-1)!);

    expect(await screen.findByText('Ring access denied')).toBeTruthy();
  });
});
