// apps/web/src/components/devices/networkDevice/settings/IdentitySection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentitySection } from './IdentitySection';
import { fetchWithAuth } from '@/stores/auth';
import type { DiscoveredAsset } from '@/components/discovery/DiscoveredAssetList';

vi.mock('@/stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('@/components/shared/Toast', () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown = { success: true }, status = 200): Response =>
  ({ ok: status < 400, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const asset: DiscoveredAsset = {
  id: 'asset-1', ip: '10.0.0.2', mac: '—', hostname: 'core-sw-01', label: 'Main Switch',
  type: 'switch', approvalStatus: 'approved', isOnline: true, manufacturer: 'Cisco',
  typeSource: 'auto', tags: ['core'], notes: 'Closet A',
};

const props = { asset, assetId: asset.id, onSaved: vi.fn(), onAnnounce: vi.fn() };
const patchBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string);

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  props.onSaved = vi.fn();
});

describe('IdentitySection', () => {
  it('starts clean — Save and Cancel are disabled until something changes', () => {
    render(<IdentitySection {...props} />);
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(screen.getByTestId('network-settings-identity-cancel')).toBeDisabled();
  });

  it('PATCHes only the changed fields', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Core Switch' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ label: 'Core Switch' });
    expect(props.onSaved).toHaveBeenCalled();
  });

  it('sends a blank display name as null so the server clears it', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ label: null });
  });

  it('splits the tags field into a trimmed array', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-tags'), { target: { value: ' core , floor-2 ,, ' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ tags: ['core', 'floor-2'] });
  });

  it('Cancel restores every field and re-disables Save', () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-notes'), { target: { value: 'Moved' } });
    expect(screen.getByTestId('network-settings-identity-save')).toBeEnabled();

    fireEvent.click(screen.getByTestId('network-settings-identity-cancel'));
    expect(screen.getByTestId('network-settings-identity-notes')).toHaveValue('Closet A');
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the consequence line only while a different type is pending', () => {
    render(<IdentitySection {...props} />);
    expect(screen.queryByTestId('network-settings-identity-type-consequence')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'printer' } });
    expect(screen.getByTestId('network-settings-identity-type-consequence')).toHaveTextContent(
      'Changes the suggested SNMP template',
    );
  });

  it('groups the type options and offers exactly the twelve the API accepts', () => {
    render(<IdentitySection {...props} />);
    const select = screen.getByTestId('network-settings-identity-type');

    expect(select.querySelectorAll('optgroup')).toHaveLength(4);
    expect(select.querySelectorAll('option:not([disabled])')).toHaveLength(12);
  });

  it('keeps an unsupported saved type selectable-but-disabled instead of silently rewriting it', () => {
    render(<IdentitySection {...props} asset={{ ...asset, type: 'website' }} />);
    const select = screen.getByTestId('network-settings-identity-type') as HTMLSelectElement;

    expect(select.value).toBe('website');
    expect(select.querySelector('option[value="website"]')).toBeDisabled();
    expect(screen.getByTestId('network-settings-identity-type-fixed')).toBeInTheDocument();
  });

  it('shows the detected-type anchor and Reset only when the type was set manually', () => {
    const { rerender } = render(<IdentitySection {...props} />);
    expect(screen.queryByTestId('network-settings-identity-type-reset')).not.toBeInTheDocument();

    rerender(<IdentitySection {...props} asset={{ ...asset, typeSource: 'manual', detectedType: 'router' }} />);
    expect(screen.getByTestId('network-settings-identity-type-detected')).toHaveTextContent('Router');
    expect(screen.getByTestId('network-settings-identity-type-reset')).toBeInTheDocument();
  });

  it('Reset PATCHes resetTypeToAuto and discards any pending type edit', async () => {
    render(<IdentitySection {...props} asset={{ ...asset, typeSource: 'manual', detectedType: 'router' }} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'printer' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-type-reset'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(patchBody()).toEqual({ resetTypeToAuto: true });
  });

  it('reloads and drops the draft when the save 409s (spec §14)', async () => {
    fetchMock.mockResolvedValue(ok({ error: 'Asset changed' }, 409));
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Core Switch' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(screen.getByTestId('network-settings-identity-name')).toHaveValue('Main Switch');
    expect(await screen.findByTestId('network-settings-identity-conflict')).toBeInTheDocument();
  });
});
