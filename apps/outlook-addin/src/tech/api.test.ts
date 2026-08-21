import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bindTechnician,
  createTicketFromEmail,
  fetchDraft,
  fetchEmailContext,
  fetchRunningTimer,
  linkEmail,
  logTime,
  searchOrgs,
  startTimer,
  stopTimer,
  TechApiError,
} from './api';
import { __resetSessionForTests } from '@breeze/office-addin-core';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function seedTechSession(): void {
  sessionStorage.setItem(
    'breeze-office-addin-session-v2',
    JSON.stringify({
      v: 2,
      persona: 'tech',
      sessionToken: 'tech-tok',
      expiresAt: Date.now() + 60_000,
      user: { id: 'u-2', email: 'tech@partner.example', name: 'Tech User' },
      partner: { id: 'p-1' },
    }),
  );
}

beforeEach(() => {
  __resetSessionForTests();
  sessionStorage.clear();
  seedTechSession();
});

describe('tech api.ts wrappers', () => {
  it('fetchEmailContext POSTs the identity + itemGeneration to /office-addin/email-context', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        itemGeneration: 3,
        org: { id: 'org-1', name: 'Acme' },
        contacts: [],
        threadMatchedTicket: null,
        openTickets: [],
        recentTickets: [],
        orgSummary: null,
        inboundPathConfigured: true,
      }),
    );
    const result = await fetchEmailContext(
      {
        from: { email: 'a@acme.com', name: 'A' },
        subject: 'Printer down',
        itemGeneration: 3,
      },
      {},
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.org).toEqual({ id: 'org-1', name: 'Acme' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/email-context');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer tech-tok');
    expect(JSON.parse(init.body as string)).toEqual({
      from: { email: 'a@acme.com', name: 'A' },
      subject: 'Printer down',
      itemGeneration: 3,
    });
  });

  it('searchOrgs POSTs the query to /office-addin/orgs/search', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { orgs: [{ id: 'org-1', name: 'Acme' }] }));
    const result = await searchOrgs('acme', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ orgs: [{ id: 'org-1', name: 'Acme' }] });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/orgs/search');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'acme' });
  });

  it('createTicketFromEmail POSTs to /office-addin/tickets/from-email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, {
        ticket: { id: 't-1', internalNumber: 'T-2026-0001', subject: 'x', status: 'new' },
        alreadyExisted: false,
      }),
    );
    await createTicketFromEmail(
      {
        orgId: 'org-1',
        subject: 'Printer down',
        description: 'desc',
        from: { email: 'a@acme.com' },
        requester: { kind: 'raw' },
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/tickets/from-email');
    expect(init.method).toBe('POST');
  });

  it('linkEmail POSTs to /office-addin/tickets/:id/link-email', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { linked: true, alreadyLinked: false, commentId: 'c-1' }),
    );
    await linkEmail(
      't-1',
      { visibility: 'public', from: { email: 'a@acme.com' }, subject: 'x', bodyText: 'y' },
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/tickets/t-1/link-email');
  });

  it('fetchDraft POSTs to /office-addin/tickets/draft', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        draft: { subject: 's', summary: 'sum', suggestedTimeMinutes: 15, inputTokens: 1, outputTokens: 1 },
      }),
    );
    await fetchDraft(
      { orgId: 'org-1', subject: 'x', bodyText: 'y' },
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/tickets/draft');
  });

  it('fetchRunningTimer GETs /office-addin/time/running', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { running: null }));
    const result = await fetchRunningTimer(fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ running: null });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/time/running');
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('startTimer POSTs to /office-addin/time/start', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, {
        entry: { id: 'te-1', ticketId: 't-1', startedAt: '2026-08-15T00:00:00Z' },
        autoStopped: null,
      }),
    );
    await startTimer({ ticketId: 't-1' }, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/time/start');
  });

  it('stopTimer POSTs to /office-addin/time/stop', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { entry: { id: 'te-1' } }));
    await stopTimer({}, fetchImpl as unknown as typeof fetch);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/time/stop');
  });

  it('logTime POSTs to /office-addin/time/log', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { entry: { id: 'te-1' } }));
    await logTime(
      {
        ticketId: 't-1',
        startedAt: '2026-08-15T00:00:00Z',
        endedAt: '2026-08-15T01:00:00Z',
        description: 'work',
      },
      fetchImpl as unknown as typeof fetch,
    );
    const [url] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/time/log');
  });

  it('bindTechnician POSTs to /office-addin/auth/bind WITHOUT a Bearer header (no session yet)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { bound: true }));
    const result = await bindTechnician(
      { accessToken: 'entra-tok', email: 'tech@partner.example', password: 'pw', mfaCode: '123456' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result).toEqual({ bound: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/office-addin/auth/bind');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('throws TechApiError with the server error code on a non-ok response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, { error: 'not_found' }));
    await expect(searchOrgs('x', fetchImpl as unknown as typeof fetch)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await expect(searchOrgs('x', fetchImpl as unknown as typeof fetch)).rejects.toBeInstanceOf(
      TechApiError,
    );
  });
});
