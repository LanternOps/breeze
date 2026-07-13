import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args) }));
vi.mock('../shared/Toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));
vi.mock('@/lib/navigation', () => ({ navigateTo: (...args: unknown[]) => navigateTo(...args) }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login?next=/integrations' }));

import TdSynnexSftpPanel from './TdSynnexSftpPanel';

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const statusPayload = {
  data: {
    configured: true,
    enabled: true,
    id: 'sftp-1',
    region: 'US',
    accountNumber: '123456',
    username: 'u123456',
    remoteFileName: '123456.zip',
    host: 'sftp.tdsynnex.example',
    credentials: { password: '********' },
    lastTestStatus: null,
    lastTestAt: null,
    lastTestError: null,
    lastSyncStatus: 'ok',
    lastSyncAt: '2026-07-10T02:00:00.000Z',
    lastSyncError: null,
    lastFileName: '123456.AP',
    lastRowCount: 42891,
  },
};

const product = {
  id: 'row-1',
  synnexSku: 'SNX-1',
  mfgPartNo: 'MPN-1',
  name: 'ThinkPad Dock',
  description: 'USB-C dock',
  status: 'Active',
  currency: 'USD',
  cost: '100.0000', // numeric columns arrive as strings
  msrp: '150.0000',
  totalQty: 7,
  warehouses: [{ code: 'CA', qty: 7 }],
  syncedAt: '2026-07-10T02:00:00.000Z',
};

// Route fetch by URL (not call order) so an extra/reordered request can't shift
// a positional mock queue (the no-positional-mock lesson).
let statusResponse: Response;
let configResponse: Response;
let testResponse: Response;
let syncResponse: Response;
let productsResponse: Response;

describe('TdSynnexSftpPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusResponse = jsonResponse(statusPayload);
    configResponse = jsonResponse(statusPayload);
    testResponse = jsonResponse({ data: { success: true, fileFound: true, message: 'Connected. Found 123456.zip.' } });
    syncResponse = jsonResponse({ data: { queued: true, jobId: 'job-1' } });
    productsResponse = jsonResponse({ data: [] });
    fetchWithAuth.mockImplementation((url: string) => {
      if (typeof url === 'string') {
        if (url.includes('/td-synnex-sftp/products')) return Promise.resolve(productsResponse);
        if (url.includes('/td-synnex-sftp/config')) return Promise.resolve(configResponse);
        if (url.includes('/td-synnex-sftp/test')) return Promise.resolve(testResponse);
        if (url.includes('/td-synnex-sftp/sync')) return Promise.resolve(syncResponse);
        if (url.includes('/td-synnex-sftp/status')) return Promise.resolve(statusResponse);
      }
      return Promise.resolve(statusResponse);
    });
  });

  it('renders the config form and the product search box after loading status', async () => {
    render(<TdSynnexSftpPanel />);
    await waitFor(() => expect(screen.getByLabelText(/Account number/i)).toBeInTheDocument());
    expect(screen.getByPlaceholderText(/Search by SKU/i)).toBeInTheDocument();
  });

  it('renders the derived username, remote filename, and host read-only', async () => {
    render(<TdSynnexSftpPanel />);
    expect(await screen.findByTestId('td-synnex-sftp-panel')).toBeTruthy();

    expect(screen.getByTestId('td-synnex-sftp-username').textContent).toBe('u123456');
    expect(screen.getByTestId('td-synnex-sftp-remote-file').textContent).toBe('123456.zip');
    expect(screen.getByTestId('td-synnex-sftp-host').textContent).toBe('sftp.tdsynnex.example');
    // Read-only: the derived block renders text, never editable fields.
    const derived = screen.getByTestId('td-synnex-sftp-derived');
    expect(derived.querySelectorAll('input, select, textarea')).toHaveLength(0);
  });

  it('keeps the password input empty when a secret is stored (never echoes the mask)', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    const password = screen.getByTestId('td-synnex-sftp-password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(password.value).toBe('');
    expect(password.placeholder).toBe('********');
    expect(screen.getByTestId('td-synnex-sftp-password-hint')).toBeTruthy();
  });

  it('saves configuration with runAction and omits the password when left blank', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    fireEvent.change(screen.getByTestId('td-synnex-sftp-account-number'), { target: { value: '654321' } });
    fireEvent.change(screen.getByTestId('td-synnex-sftp-region'), { target: { value: 'CA' } });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-save'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-sftp/config',
        expect.objectContaining({ method: 'PUT' })
      );
    });

    const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/catalog/distributors/td-synnex-sftp/config');
    const body = JSON.parse(call![1].body as string);
    expect(body).toEqual({ enabled: true, region: 'CA', accountNumber: '654321' });
    expect(body).not.toHaveProperty('password'); // the mask is never sent back
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('sends the password only when the user typed a new one', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    fireEvent.change(screen.getByTestId('td-synnex-sftp-password'), { target: { value: 'new-secret' } });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-save'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-sftp/config',
        expect.objectContaining({ method: 'PUT' })
      );
    });

    const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/catalog/distributors/td-synnex-sftp/config');
    expect(JSON.parse(call![1].body as string).password).toBe('new-secret');
  });

  it('tests the connection and renders the success indicator', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    // After the test the panel reloads status, which now carries lastTestStatus.
    statusResponse = jsonResponse({ data: { ...statusPayload.data, lastTestStatus: 'ok', lastTestAt: '2026-07-13T00:00:00.000Z' } });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-test'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-sftp/test',
        expect.objectContaining({ method: 'POST' })
      );
    });

    await waitFor(() =>
      expect(within(screen.getByTestId('td-synnex-sftp-status-label')).getByText(/Last test succeeded/i)).toBeTruthy()
    );
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(screen.queryByTestId('td-synnex-sftp-file-pending')).toBeNull();
  });

  it('treats a successful test with fileFound=false as informational, not a failure', async () => {
    testResponse = jsonResponse({
      data: {
        success: true,
        fileFound: false,
        message: 'Connected, but 123456.zip is not on the server yet.',
      },
    });

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');
    statusResponse = jsonResponse({ data: { ...statusPayload.data, lastTestStatus: 'ok' } });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-test'));

    const pending = await screen.findByTestId('td-synnex-sftp-file-pending');
    expect(pending.textContent).toMatch(/not generated your price file yet/i);
    // Informational, NOT a failure: success toast, no error toast, no error state.
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
    expect(showToast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
    expect(screen.queryByTestId('td-synnex-sftp-test-error')).toBeNull();
  });

  it('surfaces a failed test (HTTP-200 { success: false }) as an error', async () => {
    testResponse = jsonResponse({ data: { success: false, fileFound: false, error: 'Authentication failed' } });

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    statusResponse = jsonResponse({
      data: { ...statusPayload.data, lastTestStatus: 'error', lastTestError: 'Authentication failed' },
    });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-test'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', message: 'Authentication failed' })
      )
    );
    const errorEl = await screen.findByTestId('td-synnex-sftp-test-error');
    expect(errorEl.textContent).toMatch(/authentication failed/i);
    expect(screen.queryByTestId('td-synnex-sftp-file-pending')).toBeNull();
  });

  it('surfaces a non-2xx test failure through runAction without blanking the form', async () => {
    testResponse = jsonResponse({ error: 'SFTP not configured', code: 'SFTP_NOT_CONFIGURED' }, 422);

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');
    fireEvent.click(screen.getByTestId('td-synnex-sftp-test'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect((screen.getByTestId('td-synnex-sftp-account-number') as HTMLInputElement).value).toBe('123456');
  });

  it('queues a sync (never claims it finished)', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    fireEvent.click(screen.getByTestId('td-synnex-sftp-sync'));

    await waitFor(() => {
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/catalog/distributors/td-synnex-sftp/sync',
        expect.objectContaining({ method: 'POST' })
      );
    });
    const toast = showToast.mock.calls.map((c) => c[0]).find((a) => a.type === 'success');
    expect(toast.message).toMatch(/queued/i);
    expect(toast.message).not.toMatch(/synced|completed/i);
  });

  it('renders the last-sync status block', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    const block = screen.getByTestId('td-synnex-sftp-sync-status');
    expect(within(block).getByTestId('td-synnex-sftp-sync-state').textContent).toBe('ok');
    expect(within(block).getByTestId('td-synnex-sftp-last-file').textContent).toBe('123456.AP');
    expect(within(block).getByTestId('td-synnex-sftp-last-row-count').textContent).toMatch(/42,?891/);
    expect(screen.queryByTestId('td-synnex-sftp-sync-error')).toBeNull();
  });

  it('renders a last-sync error when the nightly job failed', async () => {
    statusResponse = jsonResponse({
      data: { ...statusPayload.data, lastSyncStatus: 'error', lastSyncError: 'zip entry not found' },
    });

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');

    expect((await screen.findByTestId('td-synnex-sftp-sync-error')).textContent).toMatch(/zip entry not found/i);
  });

  it('searches the ingested price rows and renders the products table', async () => {
    productsResponse = jsonResponse({ data: [product] });

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');
    fireEvent.change(screen.getByTestId('td-synnex-sftp-search'), { target: { value: 'SNX' } });
    fireEvent.click(screen.getByTestId('td-synnex-sftp-search-button'));

    const row = await screen.findByTestId('td-synnex-sftp-product-SNX-1');
    expect(within(row).getByText('SNX-1')).toBeTruthy();
    expect(within(row).getByText('MPN-1')).toBeTruthy();
    expect(within(row).getByText('ThinkPad Dock')).toBeTruthy();
    expect(within(row).getByText(/100\.00/)).toBeTruthy(); // numeric string -> formatted
    expect(within(row).getByText('7')).toBeTruthy();

    const searchCall = fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/td-synnex-sftp/products'));
    expect(String(searchCall![0])).toContain('q=SNX');
  });

  it('shows an empty state when the search returns no rows', async () => {
    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');
    fireEvent.click(screen.getByTestId('td-synnex-sftp-search-button'));

    expect(await screen.findByTestId('td-synnex-sftp-products-empty')).toBeTruthy();
    expect(screen.queryByTestId('td-synnex-sftp-products')).toBeNull();
  });

  it('toasts (does not silently render empty) when the product search fails', async () => {
    productsResponse = jsonResponse({ error: 'boom' }, 500);

    render(<TdSynnexSftpPanel />);
    await screen.findByTestId('td-synnex-sftp-panel');
    fireEvent.click(screen.getByTestId('td-synnex-sftp-search-button'));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'boom' }))
    );
    expect(screen.queryByTestId('td-synnex-sftp-products-empty')).toBeNull();
  });
});
