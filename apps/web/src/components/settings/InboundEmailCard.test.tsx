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
// CustomerDomainsCard does its own fetches; stub it out — not under test here.
vi.mock('./CustomerDomainsCard', () => ({ CustomerDomainsCard: () => null }));

import InboundEmailCard from './InboundEmailCard';

function jsonRes(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, blob: async () => new Blob() } as unknown as Response;
}

interface CfgShape {
  enabled: boolean;
  address: string;
  inboundLocalPart: string | null;
  addressOverride: string | null;
  defaultTriageOrgId: string | null;
  autoresponderEnabled: boolean;
  unknownSenderMode: 'quarantine' | 'triage' | 'drop';
  dropUnverifiedSenders: boolean;
  autoresponseSubject: string | null;
  autoresponseBody: string | null;
  slug: string;
  domainConfigured: boolean;
}

const CFG: CfgShape = {
  enabled: false,
  address: 'acme@tickets.example.com',
  inboundLocalPart: null,
  addressOverride: null,
  defaultTriageOrgId: null,
  autoresponderEnabled: true,
  unknownSenderMode: 'quarantine',
  dropUnverifiedSenders: false,
  autoresponseSubject: null,
  autoresponseBody: null,
  slug: 'acme',
  domainConfigured: true,
};

function routeFetch(cfg: CfgShape = CFG) {
  fetchWithAuth.mockImplementation((url: string) => {
    if (url === '/ticket-config') return Promise.resolve(jsonRes({ data: { inbound: cfg } }));
    if (url === '/orgs/organizations?limit=100')
      return Promise.resolve(jsonRes({ data: [{ id: 'o-1', name: 'Acme Org' }] }));
    if (url === '/orgs/partners/me') return Promise.resolve(jsonRes({ id: 'p-1' }));
    return Promise.resolve(jsonRes({ data: [] }));
  });
}

function lastInboundPatch() {
  const call = fetchWithAuth.mock.calls.find((c) => c[0] === '/orgs/partners/me')!;
  return JSON.parse((call[1] as { body: string }).body).settings.ticketing.inbound;
}

beforeEach(() => {
  fetchWithAuth.mockReset();
});

describe('InboundEmailCard', () => {
  it('renders the inbound address and the unknown-sender mode control', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-email-card')).toBeTruthy();
    expect((screen.getByTestId('inbound-localpart') as HTMLInputElement).value).toBe('acme');
    expect(screen.getByTestId('inbound-unknown-sender-mode')).toBeTruthy();
    // The review queue no longer lives in settings (moved to the Tickets area).
    expect(screen.queryByTestId('inbound-review-queue')).toBeNull();
  });

  it('quarantine is selected by default; triage is disabled until a triage org is set', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    expect((screen.getByTestId('inbound-unknown-quarantine') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByTestId('inbound-unknown-triage') as HTMLInputElement).disabled).toBe(true);
  });

  it('triage becomes selectable once a default triage org is configured', async () => {
    routeFetch({ ...CFG, defaultTriageOrgId: 'o-1', unknownSenderMode: 'triage' });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    expect((screen.getByTestId('inbound-unknown-triage') as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId('inbound-unknown-triage') as HTMLInputElement).checked).toBe(true);
  });

  it('selecting "Drop silently" PATCHes unknownSenderMode=drop in the complete inbound object', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-unknown-drop'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    const inbound = lastInboundPatch();
    expect(inbound.unknownSenderMode).toBe('drop');
    expect(inbound).not.toHaveProperty('triageUnknownSenders'); // legacy key retired
    expect(inbound).toHaveProperty('dropUnverifiedSenders');
  });

  it('toggling "drop unverified senders" PATCHes dropUnverifiedSenders=true', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-drop-unverified-toggle'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    expect(lastInboundPatch().dropUnverifiedSenders).toBe(true);
  });

  it('toggling enable PATCHes /orgs/partners/me with the COMPLETE ticketing.inbound (no address when override is null)', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-enabled-toggle'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    const inbound = lastInboundPatch();
    expect(inbound.enabled).toBe(true);
    expect(inbound).toHaveProperty('defaultTriageOrgId');
    expect(inbound).toHaveProperty('autoresponderEnabled');
    expect(inbound).toHaveProperty('unknownSenderMode');
    expect(inbound).not.toHaveProperty('address'); // derived address is NOT re-sent as an override
  });

  it('re-sends a self-hosted address override on save so the merge does not destroy it (blocker #1)', async () => {
    routeFetch({ ...CFG, address: 'support@tickets.acme.com', addressOverride: 'support@tickets.acme.com' });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.click(screen.getByTestId('inbound-autoresponder-toggle'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    expect(lastInboundPatch().address).toBe('support@tickets.acme.com');
  });

  it('shows a live preview of the custom auto-reply body with sample variables', async () => {
    routeFetch({ ...CFG, autoresponseBody: 'Hi {{requester_name}}' });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    const preview = await screen.findByTestId('inbound-autoreply-preview');
    expect(preview.textContent).toContain('Hi Sample Requester');
  });

  it('saves the complete inbound object including auto-reply subject + body', async () => {
    routeFetch();
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    fireEvent.change(screen.getByTestId('inbound-autoreply-subject'), {
      target: { value: 'Re: {{ticket_subject}}' },
    });
    fireEvent.change(screen.getByTestId('inbound-autoreply-body'), {
      target: { value: 'Thanks {{requester_name}}' },
    });
    fireEvent.click(screen.getByTestId('inbound-autoreply-save'));
    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith('/orgs/partners/me', expect.objectContaining({ method: 'PATCH' })),
    );
    const inbound = lastInboundPatch();
    expect(inbound.autoresponseSubject).toBe('Re: {{ticket_subject}}');
    expect(inbound.autoresponseBody).toBe('Thanks {{requester_name}}');
    // No sibling field destroyed by the shallow-replace of `ticketing`.
    expect(inbound).toHaveProperty('enabled');
    expect(inbound).toHaveProperty('autoresponderEnabled');
    expect(inbound).toHaveProperty('unknownSenderMode');
    expect(inbound).toHaveProperty('dropUnverifiedSenders');
  });

  it('hides the auto-reply editor when the autoresponder is disabled', async () => {
    routeFetch({ ...CFG, autoresponderEnabled: false });
    render(<InboundEmailCard />);
    await screen.findByTestId('inbound-email-card');
    expect(screen.queryByTestId('inbound-autoreply-body')).toBeNull();
  });

  it('shows the unconfigured-domain hint when domainConfigured is false', async () => {
    routeFetch({ ...CFG, address: '', domainConfigured: false });
    render(<InboundEmailCard />);
    expect(await screen.findByTestId('inbound-address-unconfigured')).toBeTruthy();
  });
});
