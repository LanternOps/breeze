import { describe, expect, it, vi } from 'vitest';
import { ResponseTooLargeError } from '../../urlSafety';
import {
  AXCIENT_MAX_RESPONSE_BYTES,
  AXCIENT_SCOPE_MESSAGE,
  AXCIENT_UNAUTHORIZED_MESSAGE,
  AxcientClient,
  type AxcientFetchImpl,
} from './client';
import unauthorized from './__fixtures__/error-unauthorized.json';
import forbidden from './__fixtures__/error-forbidden.json';

const BASE = 'https://axapi.axcient.com/x360recover';
const KEY = 'test-axcient-key-0000';

function setup(bodies: unknown[], statuses: number[] = [], retryAfter?: string) {
  let index = 0;
  const fetchImpl = vi.fn<AxcientFetchImpl>(async () => {
    const body = bodies[index];
    const status = statuses[index++] ?? 200;
    if (body instanceof Error) throw body;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => retryAfter ?? null },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  });
  const sleepImpl = vi.fn(async (_ms: number) => {});
  return { client: new AxcientClient({ baseUrl: BASE, apiKey: KEY, fetchImpl, sleepImpl }), fetchImpl, sleepImpl };
}
const rows = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: start + i }));
const urls = (fetchImpl: ReturnType<typeof setup>['fetchImpl']) => fetchImpl.mock.calls.map(([url]) => url);

describe('AxcientClient', () => {
  it('sends GET with X-Api-Key and Accept only, no body', async () => {
    const { client, fetchImpl } = setup([{ id: 26, name: 'Synthetic MSP', active: true }]);
    await expect(client.getOrganization()).resolves.toEqual({ id: 26, name: 'Synthetic MSP', active: true });
    const init = fetchImpl.mock.calls[0]![1];
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ 'X-Api-Key': KEY, Accept: 'application/json' });
    expect(init).not.toHaveProperty('body');
  });

  it('joins base URL paths: /organization, /client, /client/101/device', async () => {
    const { client, fetchImpl } = setup([{ id: 26, name: 'Synthetic MSP', active: true }, [{ id: 1 }], [{ id: 2 }]]);
    await client.getOrganization();
    await client.listClients();
    await client.listClientDevices(101);
    expect(urls(fetchImpl)).toEqual([
      `${BASE}/organization`,
      `${BASE}/client?limit=100&offset=0`,
      `${BASE}/client/101/device?limit=100&offset=0`,
    ]);
  });

  it('pages /client with limit=100&offset=0,100,… until a short page', async () => {
    const { client, fetchImpl } = setup([rows(1, 100), rows(101, 3)]);
    const result = await client.listClients();
    expect(result).toHaveLength(103);
    expect(urls(fetchImpl)).toEqual([`${BASE}/client?limit=100&offset=0`, `${BASE}/client?limit=100&offset=100`]);
  });

  it('stops when a page repeats the previous page', async () => {
    const { client, fetchImpl } = setup([rows(1, 100), rows(1, 100), rows(1, 100)]);
    const result = await client.listClients();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(100);
    expect(new Set(result.map((row) => row.id)).size).toBe(100);
  });

  it('keeps rows that have no id rather than collapsing them into one', async () => {
    // JSON.stringify(undefined) is undefined, so a bare id key would treat every
    // id-less row as a duplicate and silently shrink the inventory. The adapter
    // rejects id-less rows; the client must not hide them first.
    const { client } = setup([[{ name: 'a' }, { name: 'b' }]]);
    await expect(client.listClients()).resolves.toEqual([{ name: 'a' }, { name: 'b' }]);
  });

  it('rejects an object envelope where an array is required', async () => {
    const { client } = setup([{ data: [{ id: 1 }] }]);
    await expect(client.listClients()).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
  });

  it('rejects a non-object row and a non-JSON body', async () => {
    await expect(setup([[1, 2]]).client.listClients()).rejects.toMatchObject({ code: 'malformed_response' });
    await expect(setup(['<html>']).client.listClients()).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects an organization without a numeric id and a string name', async () => {
    await expect(setup([{ id: '26', name: 'x' }]).client.getOrganization()).rejects.toMatchObject({ code: 'malformed_response' });
    await expect(setup([{ id: 26 }]).client.getOrganization()).rejects.toMatchObject({ code: 'malformed_response' });
    await expect(setup([[{ id: 26, name: 'x' }]]).client.getOrganization()).rejects.toMatchObject({ code: 'malformed_response' });
  });

  it('rejects a non-numeric client id before building a device path', async () => {
    const { client, fetchImpl } = setup([[]]);
    for (const bad of [Number('abc'), 0, -1, 1.5]) {
      await expect(client.listClientDevices(bad)).rejects.toMatchObject({ code: 'malformed_response' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('401 => reauth with the unauthorized message', async () => {
    const { client } = setup([unauthorized], [401]);
    await expect(client.getOrganization()).rejects.toMatchObject({
      code: 'http_401', reauth: true, message: AXCIENT_UNAUTHORIZED_MESSAGE,
    });
  });

  it('403 ForbiddenException => reauth with the scope message', async () => {
    const { client } = setup([forbidden], [403]);
    await expect(client.listClients()).rejects.toMatchObject({
      code: 'http_403', reauth: true, message: AXCIENT_SCOPE_MESSAGE,
    });
  });

  it('403 without ForbiddenException => not reauth', async () => {
    const { client } = setup(['<html>'], [403]);
    await expect(client.listClients()).rejects.toMatchObject({ code: 'http_403', reauth: false });
  });

  it('retries 429 honouring Retry-After then succeeds', async () => {
    const { client, sleepImpl } = setup([{}, [{ id: 1 }]], [429, 200], '2');
    await expect(client.listClients()).resolves.toEqual([{ id: 1 }]);
    expect(sleepImpl).toHaveBeenCalledWith(2000);
  });

  it('admin call 5xx after retries => plain ProviderRequestError', async () => {
    const { client, fetchImpl } = setup([{}, {}, {}, {}], [503, 503, 503, 503]);
    const error = await client.listClients().catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ProviderRequestError', code: 'http_503', reauth: false });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('device call 5xx after retries => AxcientCustomerRequestError', async () => {
    const { client, fetchImpl } = setup([{}, {}, {}, {}], [503, 503, 503, 503]);
    await expect(client.listClientDevices(101)).rejects.toMatchObject({
      name: 'AxcientCustomerRequestError', code: 'http_503', reauth: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('device call 429 after retries => AxcientCustomerRequestError', async () => {
    const { client } = setup([{}, {}, {}, {}], [429, 429, 429, 429]);
    await expect(client.listClientDevices(101)).rejects.toMatchObject({ name: 'AxcientCustomerRequestError', code: 'http_429' });
  });

  it('device call 404 => AxcientCustomerRequestError', async () => {
    const { client, fetchImpl } = setup([{}], [404]);
    await expect(client.listClientDevices(101)).rejects.toMatchObject({ name: 'AxcientCustomerRequestError', code: 'http_404' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('device call 401 => reauth ProviderRequestError, not a customer error', async () => {
    const { client } = setup([unauthorized], [401]);
    const error = await client.listClientDevices(101).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'ProviderRequestError', code: 'http_401', reauth: true });
  });

  it('never puts the API key in an error message', async () => {
    const boom = new Error(`boom ${KEY}`);
    const { client } = setup([boom, boom, boom, boom]);
    const error = (await client.getOrganization().catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Axcient request failed');
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(KEY);
  });

  it('caps every response body and does not retry an oversized one', async () => {
    const tooLarge = new ResponseTooLargeError(AXCIENT_MAX_RESPONSE_BYTES);
    const admin = setup([tooLarge, tooLarge]);
    await expect(admin.client.listClients()).rejects.toMatchObject({ name: 'ProviderRequestError', code: 'response_too_large' });
    expect(admin.fetchImpl).toHaveBeenCalledTimes(1);
    expect(admin.fetchImpl.mock.calls[0]![1].maxBytes).toBe(AXCIENT_MAX_RESPONSE_BYTES);
    const device = setup([tooLarge]);
    await expect(device.client.listClientDevices(101)).rejects.toMatchObject({
      name: 'AxcientCustomerRequestError', code: 'response_too_large',
    });
  });

  it('device call network failure after retries => AxcientCustomerRequestError', async () => {
    // One slow or unreachable customer must not abort every other customer's
    // sync on every poll. An admin call still fails the run.
    const boom = new Error('timeout');
    const { client } = setup([boom, boom, boom, boom]);
    await expect(client.listClientDevices(101)).rejects.toMatchObject({
      name: 'AxcientCustomerRequestError', code: 'network', message: 'Axcient request failed',
    });
  });

  it('abort() stops new requests', async () => {
    const { client, fetchImpl } = setup([[{ id: 1 }]]);
    client.abort();
    await expect(client.listClients()).rejects.toMatchObject({ code: 'aborted' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws too_many_pages past the page cap', async () => {
    let next = 0;
    const fetchImpl: AxcientFetchImpl = async () => {
      next += 100;
      return { ok: true, status: 200, text: async () => JSON.stringify(rows(next, 100)) };
    };
    const client = new AxcientClient({ baseUrl: BASE, apiKey: KEY, fetchImpl, sleepImpl: async () => {} });
    await expect(client.listClients()).rejects.toMatchObject({ code: 'too_many_pages' });
  });
});
