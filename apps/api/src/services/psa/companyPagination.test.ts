/**
 * getCompanies() pagination contract, across every org-import-capable adapter.
 *
 * This is a cross-adapter contract rather than five near-identical per-adapter
 * suites: the cap/`truncated` semantics and the cursor origin-pin are one
 * guarantee that must hold identically everywhere, and #3246 shipped the
 * mechanism once (services/psa/pagination.ts) for exactly that reason.
 *
 * The two SSRF cases are the important ones. Autotask's `pageDetails.nextPageUrl`
 * and Zendesk's `next_page` come out of the PSA's own response body, and every
 * adapter's request path attaches the connection's credentials — so an
 * off-origin cursor that got followed would forward those credentials to a host
 * of the PSA's choosing. Both tests assert the refusal AND that psaFetch was
 * never called for the hostile URL.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { psaFetch } from './http';
import { AutotaskProvider } from './autotask';
import { ConnectWiseProvider } from './connectwise';
import { FreshserviceProvider } from './freshservice';
import { ServiceNowProvider } from './servicenow';
import { ZendeskProvider } from './zendesk';
import { PsaCursorOriginError } from './pagination';
import { createPsaCompanyImportSource } from './companyImport';

vi.mock('./http', () => ({ psaFetch: vi.fn() }));

const psaFetchMock = vi.mocked(psaFetch);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

/** n synthetic companies, ids offset so pages are distinguishable. */
function companies(n: number, offset = 0) {
  return Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, name: `Co ${offset + i + 1}` }));
}

/** Every URL psaFetch was asked to dial, in order. */
function dialedUrls(): string[] {
  return psaFetchMock.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  // mockReset, NOT clearAllMocks: `clearAllMocks` keeps any `mockImplementation`
  // a previous test installed, so an exhausted `mockResolvedValueOnce` queue
  // silently fell through to another provider's leftover implementation and
  // tests passed for the wrong reason. Reset, then install an explicit default
  // that ends any walk which runs past its queued pages.
  psaFetchMock.mockReset();
  psaFetchMock.mockImplementation(async () => json([]));
});

// ─────────────────────────────────────────────────────────────────────────────
// Page-number / offset providers
// ─────────────────────────────────────────────────────────────────────────────

describe('ConnectWiseProvider.getCompanies', () => {
  const provider = () =>
    new ConnectWiseProvider({
      baseUrl: 'https://cw.example.com/v4_6_release/apis/3.0',
      companyId: 'acme',
      publicKey: 'pub',
      privateKey: 'priv'
    });

  it('walks pages until an EMPTY page ends the list', async () => {
    psaFetchMock
      .mockResolvedValueOnce(json(companies(100)))
      .mockResolvedValueOnce(json(companies(100, 100)))
      .mockResolvedValueOnce(json(companies(7, 200)))
      .mockResolvedValueOnce(json([]));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(207);
    expect(result.truncated).toBe(false);
    // FOUR requests: the short 7-row page must NOT be treated as end-of-list.
    expect(psaFetchMock).toHaveBeenCalledTimes(4);
    expect(dialedUrls()[0]).toContain('pageSize=100&page=1');
    expect(dialedUrls()[3]).toContain('page=4');
    expect(result.companies[0]).toEqual({ id: '1', name: 'Co 1', externalId: '1' });
  });

  it('keeps reading when the provider clamps the page size below the request', async () => {
    // The regression this guards: a provider that caps per-page at 30 used to
    // look like end-of-list on page 1, so the tech saw 30 companies with NO
    // truncation warning and believed the whole PSA was onboarded.
    psaFetchMock
      .mockResolvedValueOnce(json(companies(30)))
      .mockResolvedValueOnce(json(companies(30, 30)))
      .mockResolvedValueOnce(json([]));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(60);
    expect(result.truncated).toBe(false);
    expect(psaFetchMock).toHaveBeenCalledTimes(3);
  });

  it('filters deleted companies and orders deterministically, server-side', async () => {
    psaFetchMock.mockResolvedValueOnce(json([]));

    await provider().getCompanies();

    const url = dialedUrls()[0]!;
    expect(decodeURIComponent(url)).toContain('conditions=deletedFlag=false');
    expect(decodeURIComponent(url)).toContain('orderBy=id asc');
  });

  it('skips already-linked ids without letting them consume the cap', async () => {
    // 1..100 are already imported; the cap must be filled from 101+ so the
    // rest of a PSA larger than the cap is reachable by previewing again.
    psaFetchMock
      .mockResolvedValueOnce(json(companies(100)))
      .mockResolvedValueOnce(json(companies(100, 100)))
      .mockResolvedValueOnce(json([]));

    const skip = new Set(companies(100).map((c) => String(c.id)));
    const result = await provider().getCompanies({ skipExternalIds: skip });

    expect(result.companies).toHaveLength(100);
    expect(result.companies[0]).toMatchObject({ id: '101' });
    expect(result.alreadyLinked).toBe(100);
  });

  it('skips malformed records instead of failing the whole listing', async () => {
    psaFetchMock
      .mockResolvedValueOnce(
        json([
          { id: 1, name: 'Good Co' },
          { id: 2, name: null },
          { id: null, name: 'No Id Co' },
          { id: 3, name: '   ' },
          { id: 4, name: 'Also Good' }
        ])
      )
      .mockResolvedValueOnce(json([]));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(2);
    expect(result.companies.map((c) => c.name)).toEqual(['Good Co', 'Also Good']);
    expect(result.malformed).toBe(3);
  });

  it('stops at the limit and reports truncated', async () => {
    // A Response body may only be read once, so each call needs a fresh one.
    psaFetchMock.mockImplementation(async () => json(companies(100)));

    const result = await provider().getCompanies({ limit: 150 });

    expect(result.companies).toHaveLength(150);
    expect(result.truncated).toBe(true);
  });

  it('every request stays on the connection base URL', async () => {
    psaFetchMock
      .mockResolvedValueOnce(json(companies(100)))
      .mockResolvedValueOnce(json(companies(1, 100)));

    await provider().getCompanies();

    for (const url of dialedUrls()) {
      expect(url.startsWith('https://cw.example.com/v4_6_release/apis/3.0/')).toBe(true);
    }
  });
});

describe('FreshserviceProvider.getCompanies', () => {
  const provider = () =>
    new FreshserviceProvider({ baseUrl: 'https://acme.freshservice.com', apiKey: 'key' });

  it('requests 100 per page instead of taking the 30 default, and pages', async () => {
    psaFetchMock
      .mockResolvedValueOnce(json({ companies: companies(100) }))
      .mockResolvedValueOnce(json({ companies: companies(5, 100) }));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(105);
    expect(result.truncated).toBe(false);
    expect(dialedUrls()[0]).toContain('per_page=100&page=1');
    expect(dialedUrls()[1]).toContain('page=2');
  });

  it('reports truncated at the cap', async () => {
    psaFetchMock.mockImplementation(async () => json({ companies: companies(100) }));

    const result = await provider().getCompanies({ limit: 250 });

    expect(result.companies).toHaveLength(250);
    expect(result.truncated).toBe(true);
  });
});

describe('ServiceNowProvider.getCompanies', () => {
  const provider = () =>
    new ServiceNowProvider({ baseUrl: 'https://acme.service-now.com', username: 'u', password: 'p' });

  it('asks ServiceNow for ACTIVE rows in a deterministic order', async () => {
    psaFetchMock.mockResolvedValueOnce(json({ result: [] }));

    await provider().getCompanies();

    // Without an explicit ORDERBY, offset paging over an unstable order can
    // skip records while still reporting a complete list.
    expect(decodeURIComponent(dialedUrls()[0]!)).toContain('sysparm_query=active=true^ORDERBYsys_id');
  });

  it('advances sysparm_offset by the page size', async () => {
    psaFetchMock
      .mockResolvedValueOnce(json({ result: companies(100).map((c) => ({ sys_id: String(c.id), name: c.name })) }))
      .mockResolvedValueOnce(json({ result: [{ sys_id: '101', name: 'Co 101' }] }));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(dialedUrls()[0]).toContain('sysparm_limit=100&sysparm_offset=0');
    expect(dialedUrls()[1]).toContain('sysparm_offset=100');
    expect(result.companies[0]).toEqual({ id: '1', name: 'Co 1', externalId: '1' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cursor providers — the SSRF-relevant pair
// ─────────────────────────────────────────────────────────────────────────────

describe('a PSA larger than the cap is fully importable', () => {
  // The acceptance criterion for #3246 finding 3: an MSP with 1,500 companies
  // must be able to onboard all 1,500 through this feature. Before the
  // already-linked skip, every preview restarted at page 1 and refilled the cap
  // with companies that were already imported, so the last 500 were reachable
  // only through the CSV import this feature exists to replace.
  const ALL = companies(1500);

  /** Serve `ALL` as 100-per-page, honouring ConnectWise's `page=` parameter. */
  function serveCatalog() {
    psaFetchMock.mockImplementation(async (url: unknown) => {
      const page = Number(new URL(String(url)).searchParams.get('page') ?? '1');
      return json(ALL.slice((page - 1) * 100, page * 100));
    });
  }

  const provider = () =>
    new ConnectWiseProvider({
      baseUrl: 'https://cw.example.com',
      companyId: 'acme',
      publicKey: 'pub',
      privateKey: 'priv'
    });

  it('yields the cap first, then the remainder on the next preview', async () => {
    serveCatalog();

    // ── Round 1: nothing imported yet.
    const first = await createPsaCompanyImportSource({
      provider: 'connectwise',
      client: provider(),
      alreadyLinkedExternalIds: new Set<string>()
    }).listCompanies({ partnerId: 'p1' });

    expect(first.rows).toHaveLength(1000);
    expect(first.truncated).toBe(true);
    expect(first.truncationReason).toBe('cap');

    // ── The tech commits those; their ids become linked.
    const imported = new Set(first.rows.map((row) => row.externalId!));
    expect(imported.size).toBe(1000);

    // ── Round 2: the same walk now skips them and surfaces the REST.
    const second = await createPsaCompanyImportSource({
      provider: 'connectwise',
      client: provider(),
      alreadyLinkedExternalIds: imported
    }).listCompanies({ partnerId: 'p1' });

    expect(second.rows).toHaveLength(500);
    expect(second.truncated).toBe(false);
    expect(second.alreadyLinked).toBe(1000);

    // ── Every one of the 1,500 companies was reachable, with no duplicates.
    const all = new Set([...imported, ...second.rows.map((row) => row.externalId!)]);
    expect(all.size).toBe(1500);
  });
});

describe('AutotaskProvider.getCompanies', () => {
  const baseUrl = 'https://webservices2.autotask.net/atservicesrest';
  const provider = () =>
    new AutotaskProvider({ baseUrl, username: 'u', secret: 's', integrationCode: 'ic' });

  const page = (items: ReturnType<typeof companies>, nextPageUrl: string | null) =>
    json({ items: items.map((c) => ({ id: c.id, companyName: c.name })), pageDetails: { nextPageUrl } });

  it('follows nextPageUrl across pages', async () => {
    psaFetchMock
      .mockResolvedValueOnce(page(companies(100), `${baseUrl}/v1.0/Companies?page=2`))
      .mockResolvedValueOnce(page(companies(3, 100), null));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(103);
    expect(result.truncated).toBe(false);
    expect(dialedUrls()[1]).toBe(`${baseUrl}/v1.0/Companies?page=2`);
    expect(result.companies[0]).toEqual({ id: '1', name: 'Co 1', externalId: '1' });
  });

  it('asks Autotask for ACTIVE companies only', async () => {
    psaFetchMock.mockResolvedValueOnce(page([], null));

    await provider().getCompanies();

    expect(decodeURIComponent(dialedUrls()[0]!)).toContain('$filter=isActive eq true');
  });

  it('reports truncated when the cap stops a cursor walk', async () => {
    psaFetchMock.mockImplementation(async () =>
      page(companies(100), `${baseUrl}/v1.0/Companies?page=n`)
    );

    const result = await provider().getCompanies({ limit: 120 });

    expect(result.companies).toHaveLength(120);
    expect(result.truncated).toBe(true);
  });

  it('REFUSES a nextPageUrl on an attacker-controlled host, without dialing it', async () => {
    psaFetchMock.mockResolvedValueOnce(
      page(companies(100), 'https://attacker.example/v1.0/Companies?page=2')
    );

    await expect(provider().getCompanies()).rejects.toBeInstanceOf(PsaCursorOriginError);

    // Only the first, on-origin request was ever made — the Autotask secret and
    // integration code never reached attacker.example.
    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    expect(dialedUrls()[0]?.startsWith(baseUrl)).toBe(true);
    expect(dialedUrls().some((u) => u.includes('attacker.example'))).toBe(false);
  });

  it('REFUSES a nextPageUrl pointing at cloud metadata, without dialing it', async () => {
    psaFetchMock.mockResolvedValueOnce(
      page(companies(100), 'http://169.254.169.254/latest/meta-data/iam/security-credentials/')
    );

    await expect(provider().getCompanies()).rejects.toBeInstanceOf(PsaCursorOriginError);

    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    expect(dialedUrls().some((u) => u.includes('169.254.169.254'))).toBe(false);
  });
});

describe('ZendeskProvider.getCompanies', () => {
  const baseUrl = 'https://acme.zendesk.com';
  const provider = () =>
    new ZendeskProvider({ baseUrl, email: 'agent@acme.com', apiToken: 'tok' });

  const page = (items: ReturnType<typeof companies>, nextPage: string | null) =>
    json({ organizations: items, next_page: nextPage });

  it('follows next_page instead of stopping at the first page', async () => {
    psaFetchMock
      .mockResolvedValueOnce(page(companies(100), `${baseUrl}/api/v2/organizations.json?page=2`))
      .mockResolvedValueOnce(page(companies(2, 100), null));

    const result = await provider().getCompanies();

    expect(result.companies).toHaveLength(102);
    expect(result.truncated).toBe(false);
    expect(dialedUrls()[0]).toContain('per_page=100');
    expect(dialedUrls()[1]).toBe(`${baseUrl}/api/v2/organizations.json?page=2`);
  });

  it('REFUSES a next_page on an attacker-controlled host, without dialing it', async () => {
    psaFetchMock.mockResolvedValueOnce(
      page(companies(100), 'https://attacker.example/api/v2/organizations.json?page=2')
    );

    await expect(provider().getCompanies()).rejects.toBeInstanceOf(PsaCursorOriginError);

    // The Basic auth header (email/token) never left the Zendesk origin.
    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    expect(dialedUrls().some((u) => u.includes('attacker.example'))).toBe(false);
  });

  it('does not follow an HTTP redirect off-origin either', async () => {
    // The origin pin covers cursors in the response BODY. The other way a PSA
    // could steer us off-host is a 3xx Location header — safeFetch follows no
    // redirects by default (services/urlSafety.ts) and the adapter treats any
    // non-2xx as an error, so the credentials stop here. Locked in because a
    // future "follow redirects" convenience flag would silently void the pin.
    psaFetchMock.mockResolvedValueOnce(
      new Response('', { status: 302, headers: { Location: 'https://attacker.example/x' } })
    );

    await expect(provider().getCompanies()).rejects.toThrow(/Zendesk API error \(302\)/);

    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    expect(dialedUrls().some((u) => u.includes('attacker.example'))).toBe(false);
  });

  it('REFUSES a next_page pointing at cloud metadata, without dialing it', async () => {
    psaFetchMock.mockResolvedValueOnce(
      page(companies(100), 'http://169.254.169.254/latest/meta-data/')
    );

    await expect(provider().getCompanies()).rejects.toBeInstanceOf(PsaCursorOriginError);

    expect(psaFetchMock).toHaveBeenCalledTimes(1);
    expect(dialedUrls().some((u) => u.includes('169.254.169.254'))).toBe(false);
  });
});
