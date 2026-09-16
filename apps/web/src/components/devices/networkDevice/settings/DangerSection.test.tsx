// apps/web/src/components/devices/networkDevice/settings/DangerSection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DangerSection } from './DangerSection';
import { showToast } from '@/components/shared/Toast';
import { fetchWithAuth } from '@/stores/auth';
import { navigateTo } from '@/lib/navigation';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const navigateMock = vi.mocked(navigateTo);
const res = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01', label: 'Main Switch',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onClose: vi.fn(), onAnnounce: vi.fn() };
const lastCall = () => fetchMock.mock.calls.at(-1)!;

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(res());
  navigateMock.mockReset();
  props.onSaved = vi.fn();
  props.onClose = vi.fn();
  props.onAnnounce = vi.fn();
});

describe('DangerSection — approval', () => {
  it('hides Approve for an already-approved asset and offers Dismiss', () => {
    render(<DangerSection {...props} />);
    expect(screen.queryByTestId('network-settings-approve')).not.toBeInTheDocument();
    expect(screen.getByTestId('network-settings-dismiss')).toBeInTheDocument();
  });

  it('explains the pending state and PATCHes /approve', async () => {
    render(<DangerSection {...props} asset={{ ...asset, approvalStatus: 'pending' }} />);

    expect(screen.getByTestId('network-settings-approval-explainer'))
      .toHaveTextContent(/nothing is monitored yet/i);

    fireEvent.click(screen.getByTestId('network-settings-approve'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1/approve');
    expect((lastCall()[1] as RequestInit).method).toBe('PATCH');
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('explains the dismissed state, offers only Approve, and PATCHes /dismiss from approved', async () => {
    const { rerender } = render(<DangerSection {...props} asset={{ ...asset, approvalStatus: 'dismissed' }} />);
    expect(screen.getByTestId('network-settings-approval-explainer'))
      .toHaveTextContent(/hidden from device lists/i);
    expect(screen.queryByTestId('network-settings-dismiss')).not.toBeInTheDocument();

    rerender(<DangerSection {...props} />);
    fireEvent.click(screen.getByTestId('network-settings-dismiss'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1/dismiss');
    expect((lastCall()[1] as RequestInit).method).toBe('PATCH');
  });
});

describe('DangerSection — delete', () => {
  const openConfirm = () => fireEvent.click(screen.getByTestId('network-settings-delete'));

  it('enumerates what the delete cascades before asking', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    const dialog = await screen.findByTestId('network-settings-delete-dialog');
    expect(dialog).toHaveTextContent(/SNMP polling configuration/i);
    expect(dialog).toHaveTextContent(/collected metrics/i);
    expect(dialog).toHaveTextContent(/Every network check bound to this asset/i);
    expect(dialog).toHaveTextContent(/topology/i);
  });

  it('keeps Confirm inert until the display name is typed exactly', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    const confirm = await screen.findByTestId('network-settings-delete-confirm');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    fireEvent.change(screen.getByTestId('network-settings-delete-confirm-input'), { target: { value: 'Main Swi' } });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(confirm);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('arms on a case-insensitive, trimmed match and then DELETEs, closes and navigates away', async () => {
    render(<DangerSection {...props} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: '  main switch  ' },
    });
    const confirm = screen.getByTestId('network-settings-delete-confirm');
    expect(confirm).not.toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(confirm);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(lastCall()[0]).toBe('/discovery/assets/asset-1');
    expect((lastCall()[1] as RequestInit).method).toBe('DELETE');
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
    expect(navigateMock).toHaveBeenCalledWith('/devices#deviceClass=network');
  });

  it('stays put when the delete fails — no close, no navigation', async () => {
    fetchMock.mockResolvedValue(res({ error: 'Access to this site denied' }, 403));
    render(<DangerSection {...props} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: 'Main Switch' },
    });
    fireEvent.click(screen.getByTestId('network-settings-delete-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(props.onClose).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('falls back to hostname, then IP, for the phrase when there is no display name', async () => {
    render(<DangerSection {...props} asset={{ ...asset, label: null }} />);
    openConfirm();

    fireEvent.change(await screen.findByTestId('network-settings-delete-confirm-input'), {
      target: { value: 'core-sw-01' },
    });
    expect(screen.getByTestId('network-settings-delete-confirm')).not.toHaveAttribute('aria-disabled', 'true');
  });
});

it('shows a refresh error after a successful mutation when onSaved returns false', async () => {
  render(<DangerSection {...props} onSaved={vi.fn().mockResolvedValue(false)} />);
  fireEvent.click(screen.getByTestId('network-settings-dismiss'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({
    type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.',
  }));
});
