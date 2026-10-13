import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import VaultConfigDialog from './VaultConfigDialog';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
const fetchMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

const json = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const page = { nextCursor: null, returned: 2, total: 2, hasMore: false, observedAt: '' };
const dev = (id: string, hostname: string) => ({ id, hostname, displayName: null, osType: 'linux', status: 'online', siteId: null, siteName: null });

describe('VaultConfigDialog device options', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(json({ data: [dev('d-99', 'zzz-vault-device')], page: { ...page, returned: 1, total: 1 } }));
  });

  it('hydrates an edit selection without a general device list', async () => {
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-99', vaultPath: '/vault', type: 'local' }} onClose={vi.fn()} />);
    expect(await screen.findByText('zzz-vault-device')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/devices/options?');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('includeIds=d-99');
  });
});

describe('VaultConfigDialog (#8385)', () => {
  const mutations = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/backup/vault'));

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/devices/options')) {
        // aaa sorts first; the vault under edit lives on the SECOND option.
        return json({ data: [dev('d-1', 'aaa-first-device'), dev('d-2', 'bbb-vault-device')], page });
      }
      if (String(input).startsWith('/backup/vault')) return json({ id: 'v-1', deviceConfig: { status: 'queued' } });
      return json({}, false, 404);
    });
  });

  it('edit mode shows the vault device, not the first option', async () => {
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-2', vaultPath: '/vault', type: 'local' }} onClose={vi.fn()} />);
    expect(await screen.findByText('bbb-vault-device')).toBeInTheDocument();
    expect(screen.queryByText('aaa-first-device')).toBeNull();
  });

  it('edit PATCH sends vaultType (not type) and no deviceId', async () => {
    const onClose = vi.fn();
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-2', vaultPath: '/vault', type: 'local' }} onClose={onClose} />);
    await screen.findByText('bbb-vault-device');
    fireEvent.click(screen.getByLabelText(/^SMB/));
    fireEvent.click(screen.getByRole('button', { name: 'Update Vault' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const [url, init] = mutations()[0] as [string, RequestInit];
    expect(url).toBe('/backup/vault/v-1');
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body.vaultType).toBe('smb');
    expect(body).not.toHaveProperty('type');
    expect(body).not.toHaveProperty('deviceId');
  });

  it('create POST sends vaultType (not type) with the chosen device', async () => {
    const onClose = vi.fn();
    render(<VaultConfigDialog vault={null} onClose={onClose} />);
    fireEvent.click(await screen.findByText('bbb-vault-device'));
    fireEvent.change(document.getElementById('vault-path') as HTMLInputElement, { target: { value: '\\\\nas\\v' } });
    fireEvent.click(screen.getByLabelText(/^SMB/));
    fireEvent.click(screen.getByRole('button', { name: 'Create Vault' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    const [url, init] = mutations()[0] as [string, RequestInit];
    expect(url).toBe('/backup/vault');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ deviceId: 'd-2', vaultType: 'smb', vaultPath: '\\\\nas\\v' });
    expect(body).not.toHaveProperty('type');
  });

  it('warns (but still closes as saved) when the config could not be sent to the device', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/devices/options')) return json({ data: [dev('d-2', 'bbb-vault-device')], page });
      return json({ id: 'v-1', deviceConfig: { status: 'failed', error: 'device offline' } });
    });
    const onClose = vi.fn();
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-2', vaultPath: '/vault', type: 'local' }} onClose={onClose} />);
    await screen.findByText('bbb-vault-device');
    fireEvent.click(screen.getByRole('button', { name: 'Update Vault' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'warning', message: expect.stringContaining('device offline') }),
    );
  });

  it('a failed save is toasted by runAction and keeps the dialog open', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (String(input).includes('/devices/options')) return json({ data: [dev('d-2', 'bbb-vault-device')], page });
      return json({ error: 'nope' }, false, 400);
    });
    const onClose = vi.fn();
    render(<VaultConfigDialog vault={{ id: 'v-1', deviceId: 'd-2', vaultPath: '/vault', type: 'local' }} onClose={onClose} />);
    await screen.findByText('bbb-vault-device');
    fireEvent.click(screen.getByRole('button', { name: 'Update Vault' }));
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'nope' })));
    expect(onClose).not.toHaveBeenCalled();
  });
});
