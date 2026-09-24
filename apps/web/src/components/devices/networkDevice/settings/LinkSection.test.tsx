// apps/web/src/components/devices/networkDevice/settings/LinkSection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LinkSection } from './LinkSection';
import { showToast } from '@/components/shared/Toast';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const res = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
  linkedDeviceId: null,
};

const props = {
  asset,
  assetId: asset.id,
  extras: { siteId: 'site-1' as string | null },
  onSaved: vi.fn(),
  onAnnounce: vi.fn(),
};

const writes = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit)?.method);

beforeEach(() => {
  vi.mocked(showToast).mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(res());
  props.onSaved = vi.fn();
  props.onAnnounce = vi.fn();
});

describe('LinkSection — linked asset', () => {
  const linked: DiscoveredAsset = { ...asset, linkedDeviceId: 'dev-9', linkedDeviceName: 'WS-FRONTDESK' };

  it('links to the managed device and labels an auto link "auto-detected"', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'auto' }} />);

    const link = screen.getByTestId('network-settings-link-device');
    expect(link).toHaveTextContent('Same device as WS-FRONTDESK');
    expect(link.getAttribute('href')).toBe('/devices/dev-9');
    expect(screen.getByTestId('network-settings-link-provenance')).toHaveTextContent('auto-detected');
  });

  it('labels a manual link "set manually"', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'manual' }} />);
    expect(screen.getByTestId('network-settings-link-provenance')).toHaveTextContent('set manually');
  });

  it('describes the agent-reported management controller as a separate associated device', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'agent_report' }} />);
    expect(screen.getByTestId('network-settings-link-device')).toHaveTextContent('Management controller for WS-FRONTDESK');
    expect(screen.getByTestId('network-settings-link-device')).toHaveAttribute('href', '/devices/dev-9');
    expect(screen.getByTestId('network-settings-link-provenance')).toHaveTextContent('reported by host agent');
    expect(screen.getByText('This management controller is associated with its host and remains a separate network device.')).toBeInTheDocument();
    expect(screen.queryByText(/same (device|machine)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/auto-detected/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    expect(screen.getByText('Remove the management-controller association? Auto-linking stays off for this asset until you link it again.')).toBeInTheDocument();
    expect(writes()).toHaveLength(0);
  });

  it.each(['manual', 'auto', 'agent_report'] as const)('confirms before unlinking a %s link, then DELETEs and reloads', async (linkSource) => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource }} />);

    fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    expect(writes()).toHaveLength(0); // opening the dialog must not write

    fireEvent.click(await screen.findByTestId('network-settings-link-unlink-confirm'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/discovery/assets/asset-1/link');
    expect((writes()[0]![1] as RequestInit).method).toBe('DELETE');
    expect(props.onSaved).toHaveBeenCalled();
    expect(props.onAnnounce).toHaveBeenCalledWith('Device unlinked');
  });

  it('issues no request when the unlink confirmation is cancelled', async () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'manual' }} />);

    fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(writes()).toHaveLength(0);
  });

  it('offers no manual-link picker while already linked', () => {
    render(<LinkSection {...props} asset={{ ...linked, linkSource: 'auto' }} />);
    expect(screen.queryByTestId('network-detail-link-manually')).not.toBeInTheDocument();
  });
});

describe('LinkSection — unlinked asset', () => {
  it('explains the unlinked state and offers the manual picker', () => {
    render(<LinkSection {...props} />);

    expect(screen.getByText('Not linked to a managed device yet.')).toBeInTheDocument();
    expect(screen.getByTestId('network-detail-link-manually')).toBeInTheDocument();
    expect(screen.queryByTestId('network-settings-link-unlink')).not.toBeInTheDocument();
  });

  it('explains suppressed auto-linking only when the asset carries the stamp', () => {
    const { rerender } = render(<LinkSection {...props} />);
    expect(screen.queryByTestId('network-settings-link-suppressed')).not.toBeInTheDocument();

    rerender(<LinkSection {...props} extras={{ siteId: 'site-1', autoLinkSuppressedAt: '2026-09-01T00:00:00.000Z' }} />);
    expect(screen.getByTestId('network-settings-link-suppressed')).toHaveTextContent(/Auto-linking is off/i);
  });

  it('keeps the manual picker open and surfaces link failure inline', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(res({ data: [{ id: 'dev-9', displayName: 'WS-FRONTDESK', status: 'online' }] }));
      return Promise.resolve(res({ error: 'Device belongs to a different site' }, 400));
    });
    render(<LinkSection {...props} />);

    fireEvent.click(screen.getByTestId('network-detail-link-manually'));
    fireEvent.change(await screen.findByTestId('network-detail-link-manually-select'), { target: { value: 'dev-9' } });
    fireEvent.click(screen.getByTestId('network-detail-link-manually-submit'));

    expect(await screen.findByTestId('network-detail-link-manually-error')).toHaveTextContent('Device belongs to a different site');
    expect(screen.getByTestId('network-detail-link-manually-picker')).toBeInTheDocument();
    expect(props.onSaved).not.toHaveBeenCalled();
  });

  it('links manually through the mutation hook (POST /discovery/assets/:id/link)', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (!init?.method) return Promise.resolve(res({ data: [{ id: 'dev-9', displayName: 'WS-FRONTDESK', status: 'online' }] }));
      return Promise.resolve(res());
    });
    render(<LinkSection {...props} />);

    fireEvent.click(screen.getByTestId('network-detail-link-manually'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/devices?siteId=site-1'));
    fireEvent.change(await screen.findByTestId('network-detail-link-manually-select'), { target: { value: 'dev-9' } });
    fireEvent.click(screen.getByTestId('network-detail-link-manually-submit'));

    await waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0]![0]).toBe('/discovery/assets/asset-1/link');
    expect((writes()[0]![1] as RequestInit).method).toBe('POST');
    expect(JSON.parse((writes()[0]![1] as RequestInit).body as string)).toEqual({ deviceId: 'dev-9' });
  });
});

it('shows a refresh error after a successful mutation when onSaved returns false', async () => {
  render(<LinkSection {...props} asset={{ ...asset, linkedDeviceId: 'dev-9' }} onSaved={vi.fn().mockResolvedValue(false)} />);
  fireEvent.click(screen.getByTestId('network-settings-link-unlink'));
    fireEvent.click(await screen.findByTestId('network-settings-link-unlink-confirm'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({
    type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.',
  }));
});
