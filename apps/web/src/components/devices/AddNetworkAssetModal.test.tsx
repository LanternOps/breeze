import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #5213 W02 — the create-network-asset form. Submits through runAction (every
// mutation handler must — CLAUDE.md), requires a label, and disables submit
// until at least one of IP/hostname/URL is present (mirrors the API's
// createNetworkAssetSchema .refine()).

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

import AddNetworkAssetModal from './AddNetworkAssetModal';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const useOrgStoreMock = vi.mocked(useOrgStore);

const SITE_A = { id: 'site-aaa-111', orgId: 'org-111', name: 'HQ Office', createdAt: '2026-01-01', deviceCount: 5 };

function setOrgStore(overrides: Partial<ReturnType<typeof useOrgStore>> = {}) {
  useOrgStoreMock.mockReturnValue({
    currentPartnerId: 'partner-1',
    currentOrgId: 'org-111',
    sites: [SITE_A],
    isLoading: false,
    error: null,
    fetchSites: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useOrgStore>);
}

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 201 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'Created' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// Dialog (../shared/Dialog.tsx) auto-focuses its first focusable element via
// a `requestAnimationFrame` scheduled on open — asynchronous, so it can land
// AFTER a synchronous `userEvent.type()` has already started elsewhere,
// stealing focus mid-keystroke and depositing later characters into the
// (now-focused) label field instead. Waiting for that initial focus to
// settle before interacting with any field avoids the race.
async function waitForDialogFocus() {
  await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('asset-label')));
}

describe('AddNetworkAssetModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setOrgStore();
  });

  afterEach(() => {
    cleanup();
  });

  it('submits through runAction and posts to /devices/network', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({
        id: 'a1', deviceClass: 'network', assetType: 'printer', orgId: 'org-111', siteId: 'site-aaa-111',
        hostname: 'Warehouse printer', displayName: 'Warehouse printer', status: 'unknown',
        ipAddress: '10.4.4.4', source: 'manual', url: null,
      }),
    );
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddNetworkAssetModal isOpen onClose={onClose} onCreated={onCreated} />);
    await waitForDialogFocus();

    await userEvent.type(screen.getByTestId('asset-label'), 'Warehouse printer');
    await userEvent.type(screen.getByTestId('asset-ip'), '10.4.4.4');
    await userEvent.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      '/devices/network',
      expect.objectContaining({ method: 'POST' }),
    ));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
  });

  it('blocks submit until one of IP / hostname / URL is present', async () => {
    render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitForDialogFocus();

    await userEvent.type(screen.getByTestId('asset-label'), 'Nothing yet');
    expect(screen.getByTestId('asset-submit')).toBeDisabled();

    await userEvent.type(screen.getByTestId('asset-hostname'), 'printer.local');
    expect(screen.getByTestId('asset-submit')).not.toBeDisabled();
  });

  it('blocks submit until a label is present', async () => {
    render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitForDialogFocus();

    await userEvent.type(screen.getByTestId('asset-ip'), '10.4.4.4');
    expect(screen.getByTestId('asset-submit')).toBeDisabled();
  });

  // #5258 review — the error path had zero coverage: a regression that moved
  // resetForm()/onClose() outside the try block, or left submit permanently
  // disabled after a failure, would have shipped untested.
  it('on a failed submit: shows the error, does not close or call onCreated, and re-enables submit', async () => {
    fetchWithAuthMock.mockResolvedValue(
      makeJsonResponse({ error: 'An asset with this IP already exists in this organization' }, false, 409),
    );
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<AddNetworkAssetModal isOpen onClose={onClose} onCreated={onCreated} />);
    await waitForDialogFocus();

    await userEvent.type(screen.getByTestId('asset-label'), 'dupe');
    await userEvent.type(screen.getByTestId('asset-ip'), '10.4.4.4');
    await userEvent.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('asset-submit')).not.toBeDisabled());

    expect(onCreated).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    // The form is NOT reset — the operator's input survives a failed submit.
    expect((screen.getByTestId('asset-label') as HTMLInputElement).value).toBe('dupe');
    expect(screen.getByText(/already exists/i)).toBeInTheDocument();
  });

  it('does not post the org-scoped source field — it is server-assigned', async () => {
    fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'a1' }));
    render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
    await waitForDialogFocus();

    await userEvent.type(screen.getByTestId('asset-label'), 'x');
    await userEvent.type(screen.getByTestId('asset-ip'), '10.4.4.4');
    await userEvent.click(screen.getByTestId('asset-submit'));

    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
    const call = fetchWithAuthMock.mock.calls[0]!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).not.toHaveProperty('source');
    expect(body).not.toHaveProperty('approvalStatus');
  });
});
