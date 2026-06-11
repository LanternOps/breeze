import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AddDnsIntegrationModal from './AddDnsIntegrationModal';
import { fetchWithAuth } from '../../stores/auth';
import { showToast } from '../shared/Toast';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('../shared/Toast', () => ({
  showToast: vi.fn(),
}));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const showToastMock = vi.mocked(showToast);

function makeJsonResponse(payload: unknown, ok = true, status = ok ? 200 : 500): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  } as unknown as Response;
}

describe('AddDnsIntegrationModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('only lists the 5 supported providers (opendns + quad9 hidden)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    const select = screen.getByLabelText('Provider') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual([
      'umbrella',
      'cloudflare',
      'dnsfilter',
      'pihole',
      'adguard_home',
    ]);
    expect(options).not.toContain('opendns');
    expect(options).not.toContain('quad9');
  });

  it('renders Cloudflare-specific fields (Account ID, no apiSecret)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    // Default selection is cloudflare
    expect(screen.getByLabelText('API token')).toBeInTheDocument();
    expect(screen.getByLabelText('Account ID')).toBeInTheDocument();
    expect(screen.queryByLabelText('API secret')).toBeNull();
    expect(screen.queryByLabelText('HTTP Basic password')).toBeNull();
  });

  it('switches to Umbrella-specific fields when provider changes', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'umbrella' } });
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByLabelText('API secret')).toBeInTheDocument();
    expect(screen.getByLabelText('Organization ID')).toBeInTheDocument();
  });

  it('switches to AdGuard Home fields (HTTP Basic username + password + endpoint)', () => {
    render(<AddDnsIntegrationModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'adguard_home' } });
    expect(screen.getByLabelText('HTTP Basic username')).toBeInTheDocument();
    expect(screen.getByLabelText('HTTP Basic password')).toBeInTheDocument();
    expect(screen.getByLabelText('API endpoint')).toBeInTheDocument();
  });

  it('submits a Cloudflare integration via POST /dns-security/integrations with the right shape', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: { id: 'new-1' } }));
    const onCreated = vi.fn();
    const onClose = vi.fn();

    render(<AddDnsIntegrationModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Acme HQ' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'cf-token-abc' } });
    fireEvent.change(screen.getByLabelText('Account ID'), { target: { value: '0123456789abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => {
      expect(fetchWithAuthMock).toHaveBeenCalledWith(
        '/dns-security/integrations',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      provider: 'cloudflare',
      name: 'Acme HQ',
      apiKey: 'cf-token-abc',
      config: { accountId: '0123456789abcdef' },
      isActive: true,
    });
    expect(body.apiSecret).toBeUndefined();
    await waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', message: expect.stringMatching(/Cloudflare/) }),
      );
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders inline error and keeps modal open when API rejects (does NOT close on failure)', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      makeJsonResponse({ error: 'organizationId is required for Cisco Umbrella' }, false, 400),
    );
    const onClose = vi.fn();
    const onCreated = vi.fn();

    render(<AddDnsIntegrationModal onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'umbrella' } });
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Umbrella Prod' } });
    fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'k' } });
    fireEvent.change(screen.getByLabelText('API secret'), { target: { value: 's' } });
    // Intentionally leave Organization ID blank to trigger server-side validation
    fireEvent.click(screen.getByRole('button', { name: /Add integration/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/organizationId is required/);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
  });
});
