// apps/web/src/components/devices/networkDevice/settings/IdentitySection.test.tsx
import '@/lib/i18n';

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IdentitySection } from './IdentitySection';
import { showToast } from '@/components/shared/Toast';
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
  vi.mocked(showToast).mockClear();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(ok());
  props.onSaved = vi.fn();
  props.onAnnounce = vi.fn();
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

  it('changing the type does not PATCH until Save commits the selected type', async () => {
    render(<IdentitySection {...props} />);

    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'router' } });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/discovery/assets/asset-1', expect.objectContaining({ method: 'PATCH' }));
    expect(patchBody()).toEqual({ assetType: 'router' });
    await waitFor(() => expect(props.onAnnounce).toHaveBeenCalledWith('Identity saved'));
  });

  it('Cancel discards a pending type selection without PATCHing', () => {
    render(<IdentitySection {...props} />);
    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'router' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-cancel'));

    expect(screen.getByTestId('network-settings-identity-type')).toHaveValue('switch');
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves a pending type edit if a background refresh returns a different type', () => {
    const { rerender } = render(<IdentitySection {...props} />);
    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'router' } });

    rerender(<IdentitySection {...props} asset={{ ...asset, type: 'printer' }} />);

    expect(screen.getByTestId('network-settings-identity-type')).toHaveValue('router');
    expect(screen.getByTestId('network-settings-identity-conflict')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('disables the type select while Save is in flight, then re-enables it', async () => {
    let resolvePatch!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { resolvePatch = resolve; }));
    render(<IdentitySection {...props} />);
    fireEvent.change(screen.getByTestId('network-settings-identity-type'), { target: { value: 'router' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));

    expect(screen.getByTestId('network-settings-identity-type')).toBeDisabled();
    expect(screen.getByTestId('network-settings-identity-save')).toBeDisabled();
    expect(props.onAnnounce).not.toHaveBeenCalled();
    resolvePatch(ok());

    await waitFor(() => expect(screen.getByTestId('network-settings-identity-type')).toBeEnabled());
    expect(props.onSaved).toHaveBeenCalledOnce();
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

describe('IdentitySection — change site', () => {
  const extras = { orgId: 'org-1', siteId: 'site-a', siteName: 'HQ' };
  const SITE_A = { id: 'site-a', orgId: 'org-1', name: 'HQ' };
  const SITE_B = { id: 'site-b', orgId: 'org-1', name: 'Branch' };

  it('shows the current site and offers Change site when the asset carries an org and site', () => {
    render(<IdentitySection {...props} extras={extras} />);
    expect(screen.getByTestId('network-settings-identity-site')).toHaveTextContent('HQ');
    expect(screen.getByTestId('network-settings-identity-change-site')).toBeInTheDocument();
  });

  it('hides Change site when the org or site is unknown', () => {
    render(<IdentitySection {...props} extras={{ siteName: 'HQ' }} />);
    expect(screen.queryByTestId('network-settings-identity-change-site')).not.toBeInTheDocument();
  });

  it('moves the asset through the single writer and tells the operator what the move undid', async () => {
    fetchMock
      .mockResolvedValueOnce(ok({ data: [SITE_A, SITE_B] }))
      .mockResolvedValueOnce(ok({
        id: asset.id, siteId: 'site-b',
        siteMove: { unlinkedDevice: true, monitorsReattached: 1, topologyPoliciesDisabled: 2 },
      }));
    render(<IdentitySection {...props} extras={extras} />);

    fireEvent.click(screen.getByTestId('network-settings-identity-change-site'));
    const select = await screen.findByLabelText(/new site/i);
    fireEvent.change(select, { target: { value: 'site-b' } });
    fireEvent.click(screen.getByRole('button', { name: /move device/i }));

    await waitFor(() => expect(props.onSaved).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenLastCalledWith('/discovery/assets/asset-1', expect.objectContaining({ method: 'PATCH' }));
    expect(patchBody()).toEqual({ siteId: 'site-b' });
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'success',
      message: expect.stringMatching(/moved to branch.*link to its agent device was removed.*2 topology monitoring policies were disabled/i),
    }));
    await waitFor(() => expect(props.onAnnounce).toHaveBeenCalledWith(expect.stringMatching(/moved to branch/i)));
  });
});

it('shows a refresh error after a successful mutation when onSaved returns false', async () => {
  render(<IdentitySection {...props} onSaved={vi.fn().mockResolvedValue(false)} />);
  fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Edited' } });
    fireEvent.click(screen.getByTestId('network-settings-identity-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({
    type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.',
  }));
});

it('preserves a name draft across equal refreshes and flags a changed baseline', () => {
  const { rerender } = render(<IdentitySection {...props} />);
  fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Edited' } });
  rerender(<IdentitySection {...props} asset={{ ...asset, tags: [...asset.tags!] }} />);
  expect(screen.getByTestId('network-settings-identity-name')).toHaveValue('Edited');
  expect(screen.queryByTestId('network-settings-identity-conflict')).not.toBeInTheDocument();
  rerender(<IdentitySection {...props} asset={{ ...asset, label: 'Changed elsewhere' }} />);
  expect(screen.getByTestId('network-settings-identity-name')).toHaveValue('Edited');
  expect(screen.getByTestId('network-settings-identity-conflict')).toBeInTheDocument();
});

it('shows a refresh failure without claiming the asset reloaded after a 409', async () => {
  fetchMock.mockResolvedValue(ok({ error: 'Asset changed' }, 409));
  render(<IdentitySection {...props} onSaved={vi.fn().mockResolvedValue(false)} />);
  fireEvent.change(screen.getByTestId('network-settings-identity-name'), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByTestId('network-settings-identity-save'));
  await waitFor(() => expect(showToast).toHaveBeenCalledWith({
    type: 'error', message: 'Saved, but the page could not refresh. Reload to see the change.',
  }));
  expect(screen.getByTestId('network-settings-identity-conflict')).not.toHaveTextContent(/reloaded/i);
});
