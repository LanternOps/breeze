import { describe, it, expect, vi } from 'vitest';
import {
  COVE_PAGE_SIZE,
  CoveJsonRpcClient,
  type CoveFetchImpl,
} from './client';
import { ProviderRequestError } from '../types';
import loginSuccess from './__fixtures__/login-success.json';
import loginRejected from './__fixtures__/login-rejected.json';
import visaExpired from './__fixtures__/visa-expired.json';
import enumeratePartners from './__fixtures__/enumerate-partners.json';
import statisticsAll from './__fixtures__/statistics-page-all-statuses.json';
import statisticsM365 from './__fixtures__/statistics-page-m365.json';
import statisticsMissing from './__fixtures__/statistics-page-missing-status.json';

const CREDS = { partnerName: 'OliveTech', username: 'api@olivetech.example', password: 'sup3r-s3cret' };
const BASE_URL = 'https://api.backup.management/jsonapi';

/** A fetch stub that replays the given bodies in order and records every request. */
function stubFetch(bodies: Array<unknown | { httpStatus: number; body?: unknown } | Error>) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  let i = 0;
  const impl: CoveFetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = bodies[i++];
    if (next === undefined) throw new Error(`stubFetch: unexpected call #${i} to ${url}`);
    if (next instanceof Error) throw next;
    if (next && typeof next === 'object' && 'httpStatus' in (next as any)) {
      const spec = next as { httpStatus: number; body?: unknown };
      return {
        ok: spec.httpStatus >= 200 && spec.httpStatus < 300,
        status: spec.httpStatus,
        text: async () => JSON.stringify(spec.body ?? {}),
      };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(next) };
  });
  return { impl, calls };
}

function makeClient(bodies: Parameters<typeof stubFetch>[0]) {
  const { impl, calls } = stubFetch(bodies);
  // delayMs: 0 — the real 200ms inter-call spacing would make this suite
  // minutes long; the spacing itself is asserted separately below.
  return { client: new CoveJsonRpcClient({ baseUrl: BASE_URL, fetchImpl: impl, delayMs: 0 }), calls, impl };
}

/** A page of exactly COVE_PAGE_SIZE synthetic rows, to drive pagination. */
function fullPage(startId: number) {
  return {
    visa: `visa-page-${startId}`,
    result: {
      result: Array.from({ length: COVE_PAGE_SIZE }, (_, n) => ({
        AccountId: startId + n,
        PartnerId: 2001,
        Flags: [],
        Settings: [{ I1: `HOST-${startId + n}` }, { I59: '1' }, { D09F00: '5' }, { D09F09: '1789000000' }],
      })),
    },
  };
}

describe('CoveJsonRpcClient.login', () => {
  it('posts Login to the base URL and returns the visa and root partner', async () => {
    const { client, calls } = makeClient([loginSuccess]);
    const result = await client.login(CREDS);

    expect(result).toEqual({ visa: 'visa-after-login', partnerId: '1000', partnerName: 'OliveTech' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(BASE_URL);
    expect(calls[0]!.body).toMatchObject({
      jsonrpc: '2.0',
      method: 'Login',
      params: { partner: CREDS.partnerName, username: CREDS.username, password: CREDS.password },
    });
    // No visa on the very first call — there is none yet.
    expect(calls[0]!.body.params.visa).toBeUndefined();
  });

  it('raises reauth on a rejected login', async () => {
    const { client } = makeClient([loginRejected]);
    await expect(client.login(CREDS)).rejects.toMatchObject({
      name: 'ProviderRequestError',
      code: 'login_rejected',
      reauth: true,
    });
  });

  it('never puts the password or the visa in the error message', async () => {
    const { client } = makeClient([loginRejected]);
    // `.catch((e) => e as ProviderRequestError)` leaves the resolved type as a
    // union with client.login's success type (TS2339 on `.message`), since
    // `.catch`'s TResult is inferred independently of the success branch —
    // try/catch avoids that without changing the assertion.
    let error!: ProviderRequestError;
    try {
      await client.login(CREDS);
      throw new Error('expected client.login to reject');
    } catch (e) {
      error = e as ProviderRequestError;
    }
    expect(error.message).not.toContain(CREDS.password);
    expect(error.message).not.toContain('visa-after-login');
  });

  it('falls back to the supplied partner name when the vendor omits PartnerName', async () => {
    const { client } = makeClient([{ visa: 'v', result: { result: { PartnerId: 1000 } } }]);
    await expect(client.login(CREDS)).resolves.toEqual({ visa: 'v', partnerId: '1000', partnerName: 'OliveTech' });
  });

  it('raises malformed_response when the envelope carries neither result nor error', async () => {
    const { client } = makeClient([{ id: 'jsonrpc' }]);
    await expect(client.login(CREDS)).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('CoveJsonRpcClient.call — visa chaining', () => {
  it('sends the login visa on the next call and adopts each response visa', async () => {
    const { client, calls } = makeClient([loginSuccess, enumeratePartners, statisticsMissing]);
    await client.login(CREDS);
    await client.call('EnumeratePartners', { parentPartnerId: 1000 });
    await client.call('EnumerateAccountStatistics', { query: {} });

    expect(calls[1]!.body.params.visa).toBe('visa-after-login');   // from Login
    expect(calls[2]!.body.params.visa).toBe('visa-2');             // from EnumeratePartners
  });

  it('refuses a call before login rather than sending a visa-less request', async () => {
    const { client, impl } = makeClient([]);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({ code: 'not_authenticated' });
    expect(impl).not.toHaveBeenCalled();
  });
});

describe('CoveJsonRpcClient.call — one re-login on an expired visa', () => {
  it('re-logs in exactly once and retries the SAME call', async () => {
    const { client, calls } = makeClient([
      loginSuccess,        // 1. initial login
      visaExpired,         // 2. the call fails
      { ...loginSuccess, visa: 'visa-after-relogin' }, // 3. re-login
      enumeratePartners,   // 4. the retry succeeds
    ]);
    await client.login(CREDS);
    const partners = await client.call<unknown[]>('EnumeratePartners', { parentPartnerId: 1000 });

    expect(Array.isArray(partners)).toBe(true);
    expect(calls.map((c) => c.body.method)).toEqual([
      'Login', 'EnumeratePartners', 'Login', 'EnumeratePartners',
    ]);
    expect(calls[3]!.body.params.visa).toBe('visa-after-relogin');
  });

  it('gives up after ONE re-login — a second expiry is not retried again', async () => {
    const { client, calls } = makeClient([loginSuccess, visaExpired, loginSuccess, visaExpired]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'visa_expired',
      reauth: false,
    });
    expect(calls).toHaveLength(4);
  });

  it('a re-login that is itself REJECTED surfaces as reauth, not as a transient failure', async () => {
    const { client } = makeClient([loginSuccess, visaExpired, loginRejected]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'login_rejected',
      reauth: true,
    });
  });

  it('a PERMISSION error on a non-Login call is reauth, and is NOT retried', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { id: 'jsonrpc', error: { code: -32003, message: 'Permission denied for this operation' } },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumerateAccountStatistics', {})).rejects.toMatchObject({
      code: 'permission_denied',
      reauth: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('an ordinary vendor error is neither reauth nor retried', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { id: 'jsonrpc', error: { code: -32602, message: 'Invalid params' } },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'vendor_error',
      reauth: false,
    });
    expect(calls).toHaveLength(2);
  });
});

describe('CoveJsonRpcClient.call — transport failures', () => {
  it('retries a 5xx up to three times, then raises a non-reauth error', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      { httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 }, { httpStatus: 503 },
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'http_503',
      reauth: false,
    });
    expect(calls).toHaveLength(5); // login + 1 attempt + 3 retries
  });

  it('succeeds when a retry recovers', async () => {
    const { client } = makeClient([loginSuccess, { httpStatus: 500 }, enumeratePartners]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).resolves.toBeDefined();
  });

  it('treats 401/403 as reauth and does NOT retry them', async () => {
    const { client, calls } = makeClient([loginSuccess, { httpStatus: 401 }]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'http_401',
      reauth: true,
    });
    expect(calls).toHaveLength(2);
  });

  it('wraps a network throw as a non-reauth error after its retries', async () => {
    const { client } = makeClient([
      loginSuccess,
      new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET'),
    ]);
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({
      code: 'network',
      reauth: false,
    });
  });

  it('raises malformed_response, not a JSON parse error, on a non-JSON body', async () => {
    const { impl } = stubFetch([loginSuccess]);
    const fetchImpl: CoveFetchImpl = vi.fn(async (url, init) => {
      if (JSON.parse(init.body).method === 'Login') return impl(url, init);
      return { ok: true, status: 200, text: async () => '<html>maintenance</html>' };
    });
    const client = new CoveJsonRpcClient({ baseUrl: BASE_URL, fetchImpl, delayMs: 0 });
    await client.login(CREDS);
    await expect(client.call('EnumeratePartners', {})).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('passes an abort signal and the timeout to the fetch impl', async () => {
    const { client, impl } = makeClient([loginSuccess]);
    await client.login(CREDS);
    const init = vi.mocked(impl).mock.calls[0]![1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.timeoutMs).toBe(30_000);
    expect(init.headers['Content-Type']).toBe('application/json');
  });
});

describe('CoveJsonRpcClient.enumeratePartners', () => {
  it('flattens the subtree into VendorCustomer, excluding the root itself', async () => {
    const { client, calls } = makeClient([loginSuccess, enumeratePartners]);
    await client.login(CREDS);
    const customers = await client.enumeratePartners('1000');

    expect(calls[1]!.body.method).toBe('EnumeratePartners');
    expect(calls[1]!.body.params).toMatchObject({ parentPartnerId: 1000, fetchRecursively: true });
    expect(customers).toEqual([
      { vendorCustomerId: '2001', name: 'Acme Corp', parentId: '1000', level: 'EndCustomer', externalCode: '3f1d9b2a-0c44-4a1e-9d31-2b6a5f0c7e88' },
      { vendorCustomerId: '2002', name: 'Beta Industries', parentId: '1000', level: 'EndCustomer', externalCode: null },
      { vendorCustomerId: '2003', name: 'Gamma Holdings', parentId: '1000', level: 'Reseller', externalCode: 'GAMMA-01' },
    ]);
  });

  it('raises malformed_response when the payload is not an array', async () => {
    const { client } = makeClient([loginSuccess, { visa: 'v', result: { result: { Id: 1 } } }]);
    await client.login(CREDS);
    await expect(client.enumeratePartners('1000')).rejects.toMatchObject({ code: 'malformed_response' });
  });
});

describe('CoveJsonRpcClient.enumerateAccountStatisticsAll', () => {
  it('requests the documented column set at the root partner', async () => {
    const { client, calls } = makeClient([loginSuccess, statisticsMissing]);
    await client.login(CREDS);
    await client.enumerateAccountStatisticsAll('1000');

    const query = calls[1]!.body.params.query;
    expect(calls[1]!.body.method).toBe('EnumerateAccountStatistics');
    expect(query).toMatchObject({
      PartnerId: 1000,
      SelectionMode: 'Merged',
      StartRecordNumber: 0,
      RecordsCount: COVE_PAGE_SIZE,
    });
    expect(query.Columns).toContain('D09F00');
    expect(query.Columns).toContain('I78');
    expect(query.Columns).toHaveLength(18);
  });

  it('maps a full page, including the M365 row and the never-run row', async () => {
    const { client } = makeClient([loginSuccess, statisticsAll, statisticsM365, statisticsMissing]);
    await client.login(CREDS);
    // Three consecutive SHORT pages would stop after the first; drive them one
    // call at a time to assert the mapping, and test pagination separately.
    const devices = await client.enumerateAccountStatisticsAll('1000');

    expect(devices).toHaveLength(12);
    expect(devices.map((d) => d.status)).toEqual([
      'completed', 'completed_with_errors', 'failed', 'interrupted', 'interrupted',
      'in_progress', 'in_progress', 'in_progress', 'over_quota', 'no_selection',
      'not_started', 'unknown',
    ]);
    expect(devices[0]!.macAddresses).toEqual(['00:11:22:aa:bb:cc']);
    expect(devices[7]!.errorsCount).toBe(4);
    expect(devices[11]!.vendorStatusCode).toBe(77);
  });

  it('pages until a SHORT page and concatenates in order', async () => {
    const { client, calls } = makeClient([
      loginSuccess,
      fullPage(1),                    // exactly COVE_PAGE_SIZE -> keep going
      { visa: 'v', result: { result: [{ AccountId: 9001, PartnerId: 2001, Settings: [{ I1: 'LAST' }, { D09F00: '5' }] }] } },
    ]);
    await client.login(CREDS);
    const devices = await client.enumerateAccountStatisticsAll('1000');

    expect(devices).toHaveLength(COVE_PAGE_SIZE + 1);
    expect(devices.at(-1)!.name).toBe('LAST');
    expect(calls[1]!.body.params.query.StartRecordNumber).toBe(0);
    expect(calls[2]!.body.params.query.StartRecordNumber).toBe(COVE_PAGE_SIZE);
  });

  it('stops immediately on an EMPTY first page', async () => {
    const { client, calls } = makeClient([loginSuccess, { visa: 'v', result: { result: [] } }]);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it('ABORTS the whole enumeration when any page fails — never returns a partial list', async () => {
    // This is the single most consequential behaviour in the file: the sync job
    // DELETES rows whose vendor device vanished, so a partial enumeration that
    // looked like a success would wipe a customer's whole backup inventory.
    const { client } = makeClient([
      loginSuccess,
      fullPage(1),
      { httpStatus: 500 }, { httpStatus: 500 }, { httpStatus: 500 }, { httpStatus: 500 },
    ]);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it('refuses to page forever, raising too_many_pages past the cap', async () => {
    const bodies: unknown[] = [loginSuccess];
    for (let i = 0; i <= 200; i++) bodies.push(fullPage(i * COVE_PAGE_SIZE + 1));
    const { client } = makeClient(bodies);
    await client.login(CREDS);
    await expect(client.enumerateAccountStatisticsAll('1000')).rejects.toMatchObject({ code: 'too_many_pages' });
  });

  it('skips an identity-less row instead of failing the whole page', async () => {
    const { client } = makeClient([
      loginSuccess,
      { visa: 'v', result: { result: [
        { AccountId: null, PartnerId: 2001, Settings: [] },
        { AccountId: 1301, PartnerId: 2001, Settings: [{ I1: 'GOOD' }, { D09F00: '5' }] },
      ] } },
    ]);
    await client.login(CREDS);
    const devices = await client.enumerateAccountStatisticsAll('1000');
    expect(devices.map((d) => d.name)).toEqual(['GOOD']);
  });
});

describe('CoveJsonRpcClient — call spacing', () => {
  it('waits delayMs between calls, and not before the first', async () => {
    const waits: number[] = [];
    const { impl } = stubFetch([loginSuccess, enumeratePartners]);
    const client = new CoveJsonRpcClient({
      baseUrl: BASE_URL,
      fetchImpl: impl,
      delayMs: 200,
      sleepImpl: async (ms: number) => { waits.push(ms); },
    });
    await client.login(CREDS);
    await client.call('EnumeratePartners', {});
    expect(waits).toEqual([200]);
  });
});
