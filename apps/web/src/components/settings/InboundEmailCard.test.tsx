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

import InboundEmailCard from './InboundEmailCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

interface CfgShape {
  enabled: boolean;
  address: string;
  addressOverride: string | null;
  defaultTriageOrgId: string | null;
  autoresponderEnabled: boolean;
  slug: string;
  domainConfigured: boolean;
}

const CFG: CfgShape = {
  enabled: false,
  address: 'acme@tickets.example.com',
  addressOverride: null,
  defaultTriageOrgId: null,
  autoresponderEnabled: true,
  slug: 'acme',
  domainConfigured: true,
};

function routeFetch(queue: unknown[], cfg: CfgShape = CFG) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/ticket-config') return Promise.resolve(jsonRes({ data: { inbound: cfg } }));
    if (url.startsWith('/ticket-config/email-inbound?'))
      return Promise.resolve(jsonRes({ data: queue, pagination: { page: 1, limit: 50, total: queue.length } }));
    if (url === '/orgs/organizations?limit=100')
      return Promise.resolve(jsonRes({ data: [{ id: 'o-1', name: 'Acme Org' }] }));
    if (url.includes('/convert')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'created' } }));
    if (url.includes('/dismiss')) return Promise.resolve(jsonRes({ data: { id: 'r-1', parseStatus: 'ignored' } }));
    if (url === '/orgs/partners/me') return Promise.resolve(jsonRes({ id: 'p-1' }));
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('InboundEmailCard', () => {
  it('renders the inbound address and review queue', async () => {
    routeFetch([
      {
        id: 'r-1',
        fromAddress: 'jane@x.com',
        subject: 'printer',
        parseStatus: 'quarantined',
        error: null,
        ticketId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-email-card')).toBeTruthy();
    expect((screen.getByTestId('inbound-address') as HTMLInputElement).value).toBe('acme@tickets.example.com');
    expect(screen.getByTestId('inbound-row-r-1')).toBeTruthy();
  });

  it('toggling enable PATCHes /orgs/partners/me with the COMPLETE ticketing.inbound (no address when override is null)', async () => {
    routeFetch([]);
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-enabled-toggle'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    const body = JSON.parse(
      (fetchWithAuth.mock.calls.find((c) => c[0] === '/orgs/partners/me')![1] as { body: string }).body,
    );
    expect(body.settings.ticketing.inbound.enabled).toBe(true);
    expect(body.settings.ticketing.inbound).toHaveProperty('defaultTriageOrgId');
    expect(body.settings.ticketing.inbound).toHaveProperty('autoresponderEnabled');
    expect(body.settings.ticketing.inbound).not.toHaveProperty('address'); // derived address is NOT re-sent as an override
  });

  it('re-sends a self-hosted address override on save so the merge does not destroy it (blocker #1)', async () => {
    routeFetch([], { ...CFG, address: 'support@tickets.acme.com', addressOverride: 'support@tickets.acme.com' });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-autoresponder-toggle'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    const body = JSON.parse(
      (fetchWithAuth.mock.calls.find((c) => c[0] === '/orgs/partners/me')![1] as { body: string }).body,
    );
    expect(body.settings.ticketing.inbound.address).toBe('support@tickets.acme.com');
  });

  it('Convert opens the org picker and POSTs convert with the chosen orgId', async () => {
    routeFetch([
      {
        id: 'r-1',
        fromAddress: 'jane@x.com',
        subject: 'printer',
        parseStatus: 'quarantined',
        error: null,
        ticketId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<InboundEmailCard />);
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

  it('Dismiss PATCHes the dismiss route and refetches', async () => {
    routeFetch([
      {
        id: 'r-1',
        fromAddress: 'jane@x.com',
        subject: 'printer',
        parseStatus: 'failed',
        error: 'boom',
        ticketId: null,
        createdAt: new Date().toISOString(),
      },
    ]);
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-row-r-1');
    fireEvent.click(screen.getByTestId('inbound-dismiss-r-1'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        '/ticket-config/email-inbound/r-1/dismiss',
        expect.objectContaining({ method: 'PATCH' }),
      ),
    );
  });

  it('shows the unconfigured-domain hint when domainConfigured is false', async () => {
    routeFetch([], { ...CFG, address: '', domainConfigured: false });
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-address-unconfigured')).toBeTruthy();
  });

  it('renders the admin-only notice when the queue fetch 403s but keeps settings usable', async () => {
    fetchWithAuth.mockImplementation((url: string) => {
      if (url === '/ticket-config') return Promise.resolve(jsonRes({ data: { inbound: CFG } }));
      if (url.startsWith('/ticket-config/email-inbound?'))
        return Promise.resolve(jsonRes({ error: 'admin' }, false, 403));
      if (url === '/orgs/organizations?limit=100') return Promise.resolve(jsonRes({ data: [] }));
      return Promise.resolve(jsonRes({ data: [] }));
    });
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-email-card')).toBeTruthy();
    expect(screen.getByTestId('inbound-review-forbidden')).toBeTruthy();
    expect(screen.getByTestId('inbound-enabled-toggle')).toBeTruthy(); // settings still rendered
  });
});
