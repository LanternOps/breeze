import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import DnsSecurityPoliciesTab from './DnsSecurityPoliciesTab';
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

const samplePolicy = {
  id: 'pol-1',
  orgId: 'org-1',
  integrationId: 'int-1',
  integrationName: 'Acme Cloudflare',
  provider: 'cloudflare',
  name: 'Threat blocklist',
  description: null,
  type: 'blocklist' as const,
  domains: [
    { domain: 'malware.example.com' },
    { domain: 'phish.example.com' },
  ],
  categories: null,
  isActive: true,
  syncStatus: 'synced',
  lastSynced: '2026-05-22T20:00:00.000Z',
};

describe('DnsSecurityPoliciesTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty state when no policies exist', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [] }));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => {
      expect(screen.getByText('No DNS policies configured')).toBeInTheDocument();
    });
  });

  it('renders policy rows with type badge + domain count', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => expect(screen.getByText('Threat blocklist')).toBeInTheDocument());
    expect(screen.getByText('blocklist')).toBeInTheDocument();
    expect(screen.getByText(/Acme Cloudflare/)).toBeInTheDocument();
    expect(screen.getByText(/2 domains/)).toBeInTheDocument();
  });

  it('Expand → Add a single domain → PATCH .domains with the right add[] payload', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => expect(screen.getByText('Threat blocklist')).toBeInTheDocument());

    fireEvent.click(screen.getByText('Threat blocklist'));

    // PATCH success then refetch
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ ok: true }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));

    fireEvent.change(screen.getByLabelText(/Add domains/), {
      target: { value: 'new-bad.example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(String((patchCall as RequestInit[])?.[1]?.body));
      expect(body).toEqual({ add: [{ domain: 'new-bad.example.com' }] });
    });
  });

  it('Bulk paste with mixed separators de-dupes against existing + splits cleanly', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => expect(screen.getByText('Threat blocklist')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Threat blocklist'));

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ ok: true }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));

    // Mix newlines, commas, whitespace + a duplicate of an existing domain.
    fireEvent.change(screen.getByLabelText(/Add domains/), {
      target: {
        value: 'a.example.com\nb.example.com, c.example.com  malware.example.com',
      },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      const body = JSON.parse(String((patchCall as RequestInit[])?.[1]?.body));
      // malware.example.com is in the existing policy → filtered out.
      expect(body).toEqual({
        add: [
          { domain: 'a.example.com' },
          { domain: 'b.example.com' },
          { domain: 'c.example.com' },
        ],
      });
    });
  });

  it('Per-row trash button PATCHes remove[] with the deleted domain', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => expect(screen.getByText('Threat blocklist')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Threat blocklist'));

    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ ok: true }));
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({ data: [samplePolicy] }));

    fireEvent.click(screen.getByLabelText('Remove malware.example.com'));

    await waitFor(() => {
      const patchCall = fetchWithAuthMock.mock.calls.find(
        ([, init]) => init?.method === 'PATCH',
      );
      const body = JSON.parse(String((patchCall as RequestInit[])?.[1]?.body));
      expect(body).toEqual({ remove: ['malware.example.com'] });
    });
  });

  it('Surfaces an inline error banner when the list endpoint fails', async () => {
    fetchWithAuthMock.mockResolvedValueOnce(makeJsonResponse({}, false, 500));
    render(<DnsSecurityPoliciesTab />);
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/Failed to load policies/);
    });
    expect(showToastMock).not.toHaveBeenCalled();
  });
});
