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

  it('disables the action and prompts for an org/ring when there is no ring or org context', async () => {
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
        ringId={null}
        currentOrgId={null}
        onClose={() => {}}
      />
    );

    // The hint is shown up-front and the submit button is disabled — no doomed
    // request should fire even on click.
    await screen.findByText(/select an organization \(or an update ring\)/i);
    const submit = screen.getAllByRole('button', { name: /Approve/i }).at(-1)!;
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('confirm-fleet-action')).toBeNull();
  });

  it('enables approve when a specific org is selected (orgId is auto-injected by fetchWithAuth)', async () => {
    fetchMock.mockResolvedValue(makeJsonResponse({ id: 'patch-1', status: 'approved' }));
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
        ringId={null}
        currentOrgId="org-1"
        orgName="Acme Corp"
        onClose={() => {}}
      />
    );

    const submit = screen.getAllByRole('button', { name: /Approve/i }).at(-1)!;
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    // Approve opens the scope-naming confirm dialog; confirm fires the POST.
    fireEvent.click(await screen.findByTestId('confirm-fleet-action'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/patches/patch-1/approve',
        expect.objectContaining({ method: 'POST' })
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

    // Click the main Approve submit button — this opens the scope-naming ConfirmDialog.
    fireEvent.click(screen.getAllByRole('button', { name: /Approve/i }).at(-1)!);

    // The ConfirmDialog now shows; confirm via testid to fire the actual POST.
    fireEvent.click(await screen.findByTestId('confirm-fleet-action'));

    expect(await screen.findByText('Ring access denied')).toBeTruthy();
  });
});
