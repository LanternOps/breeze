import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

vi.mock('../../components/shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/downloadBlob', () => ({ downloadBlob: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/orgStore', () => {
  const read = () => ({ organizations: [{ id: 'org-1', name: 'Acme Corp' }], currentOrgId: 'org-1' });
  return { useOrgStore: Object.assign(read, { getState: read }) };
});

import PatchComplianceView from './PatchComplianceView';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const ok = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const D1 = '11111111-1111-1111-1111-111111111111';
const D2 = '22222222-2222-2222-2222-222222222222';
const D3 = '33333333-3333-3333-3333-333333333333';

function serve(compliance: Record<string, unknown>) {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === '/patches/compliance') return ok({ data: compliance });
    if (url === '/devices?limit=200') {
      return ok({ devices: [D1, D2, D3].map((id, i) => ({ id, hostname: `host-${i + 1}`, osType: 'linux' })) });
    }
    return ok({});
  });
}

const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id, name, os: 'linux', missingCount: 0, approvedMissing: 0, unapprovedMissing: 0, failedMissing: 0,
  criticalCount: 0, importantCount: 0, osMissing: 0, thirdPartyMissing: 0, pendingReboot: false, ...over,
});

describe('PatchComplianceView container image term (W06)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('counts a device listed only for a stale image as needing updates and shows images not checked', async () => {
    serve({
      totalDevices: 3,
      compliantDevices: 1,
      devicesNeedingPatches: [
        row(D1, 'host-1', { missingCount: 2, unapprovedMissing: 2, osMissing: 2 }),
        row(D2, 'host-2', { staleImages: 1, unknownImages: 0 }),
      ],
      containerImages: { stale: 1, current: 0, unknown: 2 },
    });
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByText('1 of 3 devices')).toBeTruthy();
    expect(screen.getByText('2 container images not checked')).toBeTruthy();
  });

  it('is unchanged without container images', async () => {
    serve({
      totalDevices: 3,
      compliantDevices: 2,
      devicesNeedingPatches: [row(D1, 'host-1', { missingCount: 2, unapprovedMissing: 2, osMissing: 2 })],
    });
    render(<PatchComplianceView ringId={null} />);
    expect(await screen.findByText('2 of 3 devices')).toBeTruthy();
    expect(screen.queryByText(/container image/)).toBeNull();
  });
});
