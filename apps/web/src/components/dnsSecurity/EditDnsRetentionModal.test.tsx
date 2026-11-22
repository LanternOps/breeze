import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EditDnsRetentionModal from './EditDnsRetentionModal';
import { fetchWithAuth } from '../../stores/auth';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);

function okResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(payload),
    clone() { return this; },
  } as unknown as Response;
}

function renderModal(storeAllowedTraffic: boolean) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(
    <EditDnsRetentionModal
      integration={{ id: 'int-1', name: 'Umbrella', retentionDays: 7, storeAllowedTraffic }}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

function sentBody(): Record<string, unknown> {
  const init = fetchWithAuthMock.mock.calls[0]![1] as RequestInit;
  return JSON.parse(String(init.body));
}

// #10054 — the allowed-traffic opt-in lives with the integration's other
// "what Breeze stores" setting (retention), in this one modal.
describe('EditDnsRetentionModal — store allowed traffic (#10054)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the opt-in off by default and saves it alongside retention', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse({ id: 'int-1', retentionDays: 7, storeAllowedTraffic: true }));
    const { onSaved } = renderModal(false);

    const toggle = screen.getByTestId('dns-store-allowed-traffic') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Only blocked and redirected queries are stored/)).toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/dns-security/integrations/int-1', expect.objectContaining({ method: 'PATCH' }));
    expect(sentBody()).toEqual({ retentionDays: 7, storeAllowedTraffic: true });
  });

  it('reflects an existing opt-in and can turn it off', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse({ id: 'int-1', retentionDays: 7, storeAllowedTraffic: false }));
    const { onSaved } = renderModal(true);

    const toggle = screen.getByTestId('dns-store-allowed-traffic') as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody()).toEqual({ retentionDays: 7, storeAllowedTraffic: false });
  });
});

// #12507 — a Pi-hole integration's API version is correctable after create.
describe('EditDnsRetentionModal — Pi-hole version (#12507)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the version select for Pi-hole and PATCHes the change', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(okResponse({ id: 'int-1' }));
    const onSaved = vi.fn();
    render(
      <EditDnsRetentionModal
        integration={{ id: 'int-1', name: 'Pi', retentionDays: null, storeAllowedTraffic: false, piholeVersion: 'v5' }}
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    const select = screen.getByLabelText('Pi-hole version') as HTMLSelectElement;
    expect(select.value).toBe('v5');
    fireEvent.change(select, { target: { value: 'v6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sentBody()).toEqual({ retentionDays: null, storeAllowedTraffic: false, piholeVersion: 'v6' });
  });

  it('hides the version select (and omits the field) for other providers', () => {
    renderModal(false);
    expect(screen.queryByLabelText('Pi-hole version')).toBeNull();
  });
});
