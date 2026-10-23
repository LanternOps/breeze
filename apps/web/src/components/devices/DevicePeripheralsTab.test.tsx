import '@/lib/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

import DevicePeripheralsTab from './DevicePeripheralsTab';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);
const deviceId = '44444444-4444-4444-4444-444444444444';

function json(body: unknown): Response {
  return { ok: true, status: 200, statusText: 'OK', json: vi.fn().mockResolvedValue(body) } as unknown as Response;
}

// #9621: "Active Policies" is the device's effective peripheral set, not every
// active policy of the organization.
describe('DevicePeripheralsTab — Active Policies (#9621)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith('/peripherals/activity')) return json({ data: [] });
      if (url === `/peripherals/devices/${deviceId}/effective`) {
        return json({
          data: [
            { id: 'p-1', name: 'Block storage at HQ', source: 'organization', deviceClass: 'storage', action: 'block', targetType: 'site', priority: 100 },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  it("lists the device's effective policies from the per-device endpoint", async () => {
    render(<DevicePeripheralsTab deviceId={deviceId} />);
    expect(await screen.findByText('Block storage at HQ')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/peripherals/devices/${deviceId}/effective`));
  });

  it('never reads the org-wide policy list for this panel', async () => {
    render(<DevicePeripheralsTab deviceId={deviceId} />);
    await screen.findByText('Block storage at HQ');
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain('/peripherals/policies');
  });
});
