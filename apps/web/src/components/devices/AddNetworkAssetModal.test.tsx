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

  // #5213 W03 — website/service targets. A URL is required outright (not
  // just "any of IP/hostname/URL"), and MAC doesn't apply to an IP-less
  // endpoint.
  describe.each(['website', 'service'] as const)('%s asset type', (assetType) => {
    it('hides the MAC field, swaps the identity hint, and requires a URL specifically — hostname alone is not enough', async () => {
      render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
      await waitForDialogFocus();

      // Default (non-url-required) type shows the "any of IP/hostname/URL" hint.
      expect(screen.getByText(/provide at least one of/i)).toBeInTheDocument();

      await userEvent.type(screen.getByTestId('asset-label'), 'Shop');
      await userEvent.selectOptions(screen.getByTestId('asset-type'), assetType);

      expect(screen.queryByTestId('asset-mac')).not.toBeInTheDocument();
      expect(screen.getByText(/require a URL/i)).toBeInTheDocument();
      expect(screen.queryByText(/provide at least one of/i)).not.toBeInTheDocument();

      await userEvent.type(screen.getByTestId('asset-hostname'), 'shop.example');
      expect(screen.getByTestId('asset-submit')).toBeDisabled();

      await userEvent.type(screen.getByTestId('asset-url'), 'https://shop.example');
      expect(screen.getByTestId('asset-submit')).not.toBeDisabled();
    });

    it('never posts a stale MAC address typed while a different asset type was selected', async () => {
      fetchWithAuthMock.mockResolvedValue(makeJsonResponse({ id: 'a1' }));
      render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
      await waitForDialogFocus();

      await userEvent.type(screen.getByTestId('asset-label'), 'Shop');
      // Type a MAC while the type still shows the field...
      await userEvent.type(screen.getByTestId('asset-mac'), '00:11:22:33:44:55');
      // ...then switch to a type that hides it. The field unmounts, but the
      // React state behind it must not leak into the payload.
      await userEvent.selectOptions(screen.getByTestId('asset-type'), assetType);
      await userEvent.type(screen.getByTestId('asset-url'), 'https://shop.example');
      await userEvent.click(screen.getByTestId('asset-submit'));

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalled());
      const call = fetchWithAuthMock.mock.calls[0]!;
      const body = JSON.parse((call[1] as RequestInit).body as string);
      expect(body.macAddress).toBeNull();
    });

    it('offers an HTTP-check hand-off after creating the asset instead of closing immediately', async () => {
      fetchWithAuthMock.mockResolvedValue(
        makeJsonResponse({ id: 'web-1', assetType, url: 'https://shop.example', source: 'manual' }),
      );
      const onCreated = vi.fn();
      const onClose = vi.fn();
      render(<AddNetworkAssetModal isOpen onClose={onClose} onCreated={onCreated} />);
      await waitForDialogFocus();

      await userEvent.type(screen.getByTestId('asset-label'), 'Shop');
      await userEvent.selectOptions(screen.getByTestId('asset-type'), assetType);
      await userEvent.type(screen.getByTestId('asset-url'), 'https://shop.example');
      await userEvent.click(screen.getByTestId('asset-submit'));

      await waitFor(() => expect(onCreated).toHaveBeenCalledWith('web-1'));
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId('asset-post-create')).toBeInTheDocument();

      await userEvent.click(screen.getByTestId('asset-post-create-done'));
      expect(onClose).toHaveBeenCalled();
    });

    // The hand-off opens CreateMonitorForm pre-selected on http_check (via
    // its `defaultMonitorType` prop) rather than the component's own
    // icmp_ping default — this test never clicks the "HTTP Check" tile, so a
    // regression back to the default type would fail it (either the
    // name-field placeholder wouldn't be the one asserted below, since
    // icmp_ping shows a different field set, or the submitted monitorType
    // would be wrong).
    it('creates an http_check monitor pre-targeted at the asset URL via the hand-off, with no extra clicks', async () => {
      fetchWithAuthMock.mockResolvedValueOnce(
        makeJsonResponse({ id: 'web-2', assetType, url: 'https://shop.example', source: 'manual' }),
      );
      render(<AddNetworkAssetModal isOpen onClose={vi.fn()} onCreated={vi.fn()} />);
      await waitForDialogFocus();

      await userEvent.type(screen.getByTestId('asset-label'), 'Shop');
      await userEvent.selectOptions(screen.getByTestId('asset-type'), assetType);
      await userEvent.type(screen.getByTestId('asset-url'), 'https://shop.example');
      await userEvent.click(screen.getByTestId('asset-submit'));

      await waitFor(() => expect(screen.getByTestId('asset-post-create-add-http-check')).toBeInTheDocument());
      await userEvent.click(screen.getByTestId('asset-post-create-add-http-check'));

      await userEvent.type(screen.getByPlaceholderText(/production web server/i), 'Shop check');

      fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ id: 'mon-1' }));
      await userEvent.click(screen.getByRole('button', { name: /create monitor/i }));

      await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/monitors',
        expect.objectContaining({ method: 'POST' }),
      ));
      const monitorCall = fetchWithAuthMock.mock.calls.find(([url]) => url === '/monitors')!;
      const monitorBody = JSON.parse((monitorCall[1] as RequestInit).body as string);
      expect(monitorBody).toMatchObject({
        assetId: 'web-2', monitorType: 'http_check', target: 'https://shop.example',
      });
    });
  });
});
