import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DevicePatchStatusTab from './DevicePatchStatusTab';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchWithAuthMock = vi.mocked(fetchWithAuth);

const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const deviceId = '11111111-1111-1111-1111-111111111111';
const linuxPending = { id: 'p1', title: 'openssl', source: 'linux', category: 'system', status: 'pending' };

function serve(data: Record<string, unknown>) {
  fetchWithAuthMock.mockImplementation(async (url: string) =>
    String(url).includes('/patches/history') ? ok({ history: [], total: 0 }) : ok({ data }));
}

describe('DevicePatchStatusTab container image term (W06)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a Linux device without workload data computes exactly the old number and shows no image text', async () => {
    serve({ compliancePercent: 100, pending: [linuxPending], installed: [] });
    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);
    await screen.findByText('openssl');
    expect(screen.getByText('0% compliant')).toBeTruthy();
    expect(screen.queryByText(/container image/)).toBeNull();
  });

  it('a Linux device folds current images in as installed items and stale ones as pending; unknowns are only reported', async () => {
    serve({
      compliancePercent: 75,
      pending: [linuxPending],
      installed: [],
      containerImages: { stale: 1, current: 3, unknown: 2 },
    });
    render(<DevicePatchStatusTab deviceId={deviceId} osType="linux" />);
    await screen.findByText('openssl');
    // (0 installed + 3 current) / (1 pending + 1 stale + 3 current), same arithmetic as the API
    expect(screen.getByText('60% compliant')).toBeTruthy();
    expect(screen.getByTestId('patch-compliance-images-not-checked').textContent).toBe('2 container images not checked');
    expect(screen.getByTestId('patch-compliance-images-behind').textContent).toBe('1 container image behind');
  });

  it('a Windows device keeps the API percentage and shows the coverage text', async () => {
    serve({
      compliancePercent: 64,
      pending: [],
      installed: [],
      containerImages: { stale: 0, current: 1, unknown: 1 },
    });
    render(<DevicePatchStatusTab deviceId={deviceId} osType="windows" />);
    expect(await screen.findByText('64% compliant')).toBeTruthy();
    expect(screen.getByTestId('patch-compliance-images-not-checked').textContent).toBe('1 container image not checked');
    expect(screen.queryByTestId('patch-compliance-images-behind')).toBeNull();
  });
});
