import '@/lib/i18n';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VaultConfigDialog from './VaultConfigDialog';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);

describe('VaultConfigDialog device options', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        data: [{ id: 'd-99', hostname: 'zzz-vault-device', displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null }],
        page: { nextCursor: null, returned: 1, total: 1, hasMore: false, observedAt: '' },
      }),
    } as unknown as Response);
  });

  it('hydrates an edit selection without a general device list', async () => {
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-99', vaultPath: '/vault', type: 'local' }} onClose={vi.fn()} />);
    expect(await screen.findByText('zzz-vault-device')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/devices/options?');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('includeIds=d-99');
  });
});
