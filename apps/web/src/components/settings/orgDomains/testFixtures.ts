import { vi } from 'vitest';
import type { CustomerDomainView } from './types';

export const ORG = '11111111-1111-4111-8111-111111111111';
export const OTHER_ORG = '33333333-3333-4333-8333-333333333333';
export const TENANT = '22222222-2222-4222-8222-222222222222';
export const DOMAINS = `/orgs/organizations/${ORG}/customer-domains`;
export const ENTRA = `/orgs/organizations/${ORG}/portal-entra-tenant`;
export const GOOGLE = `/google/connection?orgId=${ORG}`;

export function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

export function domainView(over: Partial<CustomerDomainView> = {}): CustomerDomainView {
  return {
    id: 'd1',
    orgId: ORG,
    domain: 'contoso.com',
    isActive: true,
    autoCreateContact: true,
    state: 'declared',
    method: null,
    verifiedAt: null,
    lastCheckedAt: null,
    lastPassedAt: null,
    lastCheckStatus: null,
    clearedAt: null,
    clearedReason: null,
    dnsRecord: null,
    usableForSignIn: false,
    ...over,
  };
}

export const verifiedDns = (over: Partial<CustomerDomainView> = {}) => domainView({
  state: 'verified',
  method: 'dns_txt',
  verifiedAt: '2026-11-09T10:00:00.000Z',
  lastCheckedAt: '2026-11-09T10:00:00.000Z',
  lastPassedAt: '2026-11-09T10:00:00.000Z',
  lastCheckStatus: 'pass',
  dnsRecord: { recordName: '_breeze-verify.contoso.com', recordValue: 'breeze-verification=abc123' },
  usableForSignIn: true,
  ...over,
});

type Handler = (init?: RequestInit) => Promise<Response>;

/** Routes `fetchWithAuth` calls by `METHOD url`; anything else is a 500 so a stray call is visible. */
export function routeFetch(mock: ReturnType<typeof vi.fn>, routes: Record<string, Handler>) {
  mock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;
    const handler = routes[key];
    return handler ? handler(init) : json({ error: `unexpected ${key}` }, 500);
  });
}

export const callsTo = (mock: ReturnType<typeof vi.fn>, method: string, url: string) =>
  mock.mock.calls.filter(([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
