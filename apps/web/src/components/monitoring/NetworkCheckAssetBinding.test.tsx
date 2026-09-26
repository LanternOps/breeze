import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { fetchWithAuth } from '../../stores/auth';
import NetworkCheckAssetBinding, { bindNetworkAsset } from './NetworkCheckAssetBinding';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const asset = { id: '11111111-1111-4111-8111-111111111111', label: 'Gateway', hostname: null, ipAddress: '192.0.2.1' };
const response = (data: unknown) => new Response(JSON.stringify({ data }));
beforeEach(() => vi.mocked(fetchWithAuth).mockReset());

it('loads the org-scoped envelope and selects or unbinds an asset', async () => {
  vi.mocked(fetchWithAuth).mockResolvedValue(response([asset]));
  const onSelect = vi.fn();
  render(<NetworkCheckAssetBinding orgId="org-1" assetId={null} onSelect={onSelect} />);
  await screen.findByRole('option', { name: 'Gateway' });
  expect(fetchWithAuth).toHaveBeenCalledWith('/discovery/assets?orgId=org-1');
  fireEvent.change(screen.getByTestId('network-check-asset-picker'), { target: { value: asset.id } });
  expect(onSelect).toHaveBeenCalledWith(asset);
  fireEvent.change(screen.getByTestId('network-check-asset-picker'), { target: { value: '' } });
  expect(onSelect).toHaveBeenLastCalledWith(null);
});

it.each([new Response('{}', { status: 403 }), response({}), new Error('offline')])('shows a retryable read failure', async failure => {
  const fetch = vi.mocked(fetchWithAuth);
  if (failure instanceof Error) fetch.mockRejectedValueOnce(failure);
  else fetch.mockResolvedValueOnce(failure);
  fetch.mockResolvedValueOnce(response([asset]));
  render(<NetworkCheckAssetBinding orgId="org-1" assetId={asset.id} onSelect={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load assets');
  expect(screen.getByTestId('network-check-asset-picker')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('option', { name: 'Gateway' });
  expect(screen.getByTestId('network-check-asset-picker')).toHaveValue(asset.id);
});

it('disables partner binding without reading assets', () => {
  render(<NetworkCheckAssetBinding orgId={null} assetId={null} onSelect={vi.fn()} />);
  expect(screen.getByTestId('network-check-asset-picker')).toBeDisabled();
  expect(fetchWithAuth).not.toHaveBeenCalled();
});

it.each([{ checkType: 'icmp_ping', packetSize: 1400 }, { checkType: 'http_check', headers: { 'X-Probe': 'breeze' } }])(
  'preserves API-only options through binding and unbinding', option => {
    const original = { target: 'example.com', ...option };
    const bound = bindNetworkAsset(original, asset);
    expect(bound).toMatchObject({ ...option, assetId: asset.id, target: asset.ipAddress });
    const unbound = bindNetworkAsset(bound, null);
    expect(unbound).toMatchObject(option);
    expect(unbound.assetId).toBeUndefined();
    expect(original).not.toHaveProperty('assetId');
  },
);
