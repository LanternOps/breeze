import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../lib/authScope', () => ({ loginPathWithNext: () => '/login' }));
// pass-through runAction so the request fn (and thus fetchWithAuth) runs
vi.mock('../../lib/runAction', () => ({
  runAction: async (o: { request: () => Promise<Response> }) => {
    const r = await o.request();
    return r.json().catch(() => null);
  },
  handleActionError: vi.fn(),
}));

import InboundReviewQueue from './InboundReviewQueue';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

const ROW = {
  id: 'r-1',
  fromAddress: 'jane@x.com',
  toAddress: 'acme@tickets.example.com',
  subject: 'printer',
  parseStatus: 'quarantined' as const,
  error: null,
  ticketId: null,
  createdAt: new Date().toISOString(),
};

function routeFetch(rows: unknown[]) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url.startsWith('/ticket-config/email-inbound?'))
      return Promise.resolve(jsonRes({ data: rows, pagination: { page: 1, limit: 50, total: rows.length } }));
    if (url === '/orgs/organizations?limit=100')
      return Promise.resolve(jsonRes({ data: [{ id: 'o-1', name: 'Acme Org' }] }));
    if (url.includes('/convert')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'created' } }));
    if (url.includes('/dismiss')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'ignored' } }));
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('InboundReviewQueue', () => {
  it('renders quarantined/failed rows', async () => {
    routeFetch([ROW]);
    render(<InboundReviewQueue />);
    expect(await screen.findByTestId('inbound-review-queue')).toBeTruthy();
    expect(screen.getByTestId('inbound-row-r-1')).toBeTruthy();
  });

  it('reports the pending total via onTotalChange', async () => {
    routeFetch([ROW]);
    const onTotalChange = vi.fn();
    render(<InboundReviewQueue onTotalChange={onTotalChange} />);
    await screen.findByTestId('inbound-row-r-1');
    expect(onTotalChange).toHaveBeenCalledWith(1);
  });

  it('shows the empty state when there is nothing to review', async () => {
    routeFetch([]);
    render(<InboundReviewQueue />);
    expect(await screen.findByTestId('inbound-review-empty')).toBeTruthy();
  });

  it('Convert opens the org picker and POSTs convert with the chosen orgId', async () => {
    routeFetch([ROW]);
    render(<InboundReviewQueue />);
    await screen.findByTestId('inbound-row-r-1');
    fireEvent.click(screen.getByTestId('inbound-convert-r-1'));
    fireEvent.change(screen.getByTestId('inbound-convert-org-r-1'), { target: { value: 'o-1' } });
    fireEvent.click(screen.getByTestId('inbound-convert-submit-r-1'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/ticket-config/email-inbound/r-1/convert',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const body = JSON.parse(
      (fetchWithAuth.mock.calls.find((c) => String(c[0]).includes('/convert'))![1] as { body: string }).body,
    );
    expect(body.orgId).toBe('o-1');
  });

  it('Dismiss PATCHes the dismiss route', async () => {
    routeFetch([{ ...ROW, parseStatus: 'failed', error: 'boom' }]);
    render(<InboundReviewQueue />);
    await screen.findByTestId('inbound-row-r-1');
    fireEvent.click(screen.getByTestId('inbound-dismiss-r-1'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/ticket-config/email-inbound/r-1/dismiss',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('renders the admin-only notice when the queue fetch 403s', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url.startsWith('/ticket-config/email-inbound?')) return Promise.resolve(jsonRes({ error: 'admin' }, false, 403));
      if (url === '/orgs/organizations?limit=100') return Promise.resolve(jsonRes({ data: [] }));
      return Promise.resolve(jsonRes({ data: [] }));
    });
    render(<InboundReviewQueue />);
    expect(await screen.findByTestId('inbound-review-forbidden')).toBeTruthy();
  });
});
