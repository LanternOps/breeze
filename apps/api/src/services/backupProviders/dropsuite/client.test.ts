import { describe, expect, it, vi } from 'vitest';
import { CustomerRequestError, DropsuiteClient, scrubTokens, type DropsuiteFetchImpl } from './client';
import accounts from './__fixtures__/accounts-paged-p1.json';
import tenants from './__fixtures__/tenants.json';
const BASE = 'https://example.dropsuite.us/api///';
function setup(bodies: unknown[], statuses: number[] = [], retryAfter?: string) {
  let index = 0;
  const fetchImpl: DropsuiteFetchImpl = vi.fn(async () => {
    const body = bodies[index];
    const status = statuses[index++] ?? 200;
    if (body instanceof Error) throw body;
    return { ok: status >= 200 && status < 300, status, headers: { get: () => retryAfter ?? null }, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
  });
  const sleepImpl = vi.fn(async (_ms: number) => {});
  return { client: new DropsuiteClient({ baseUrl: BASE, resellerToken: 'reseller', fetchImpl, sleepImpl }), fetchImpl, sleepImpl };
}
const page = (start: number) => Array.from({ length: 100 }, (_, i) => ({ id: start + i }));
describe('Dropsuite client', () => {
  it('joins paths and sends GET with credentials and pagination', async () => {
    const { client, fetchImpl } = setup([[{ id: 1 }]]);
    await expect(client.list('/users', 'admin')).resolves.toEqual([{ id: 1 }]);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.dropsuite.us/api/users?page=1&per_page=100', expect.objectContaining({ method: 'GET', headers: { 'X-Reseller-Token': 'reseller', 'X-Access-Token': 'admin', Accept: 'application/json' } }));
  });
  it('accepts plain status with reseller token only', async () => {
    const { client, fetchImpl } = setup(['OK']);
    await expect(client.get('status')).resolves.toBe('OK');
    expect(vi.mocked(fetchImpl).mock.calls[0]![1].headers).not.toHaveProperty('X-Access-Token');
  });
  it('requires HTTP 200 for the status probe', async () => {
    const { client } = setup(['\"OK\"'], [201]);
    await expect(client.get('status')).rejects.toMatchObject({ code: 'http_201', reauth: false });
  });
  it('pages bare arrays until empty', async () => {
    const { client, fetchImpl } = setup([page(1), []]);
    expect(await client.list('users', 'admin')).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('normalizes result_set across two pages using vendor page size', async () => {
    const { client } = setup([{ ...accounts, pagination: { current_page: 1, per_page: 4, total_pages: 2 } }, { result_set: [{ id: 5 }], pagination: { current_page: 2, per_page: 4, total_pages: 2 } }]);
    expect(await client.list('accounts', 'customer', 'customer')).toHaveLength(5);
  });
  it('normalizes tenants data envelopes', async () => {
    expect(await setup([tenants]).client.list('users/1/tenants', 'customer', 'customer')).toEqual(tenants.data);
  });
  it('stops at total_pages for a full page', async () => {
    const { client, fetchImpl } = setup([{ result_set: page(1), pagination: { current_page: 1, per_page: 100, total_pages: 1 } }]);
    expect(await client.list('users', 'admin')).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it('detects ignored-page repeats without duplicating rows', async () => {
    const { client, fetchImpl } = setup([page(1), page(1)]);
    expect(await client.list('googledrives', 'customer', 'customer')).toHaveLength(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('throws after 200 pages without returning partial data', async () => {
    const { client, fetchImpl } = setup(Array.from({ length: 200 }, (_, i) => page(i * 100)));
    await expect(client.list('users', 'admin')).rejects.toMatchObject({ code: 'too_many_pages', reauth: false });
    expect(fetchImpl).toHaveBeenCalledTimes(200);
  });
  it.each([401, 403])('classifies HTTP %s by credential scope', async (status) => {
    await expect(setup([{}], [status]).client.list('users', 'admin')).rejects.toMatchObject({ reauth: true });
    await expect(setup([{}], [status]).client.list('accounts', 'customer', 'customer')).rejects.toBeInstanceOf(CustomerRequestError);
  });
  it('classifies customer 400 not authorized but not unrelated 400', async () => {
    await expect(setup([{ errors: { user: ['not authorized secret'] } }], [400]).client.list('accounts', 'customer', 'customer')).rejects.toMatchObject({ name: 'CustomerRequestError', reauth: false, message: 'Dropsuite returned HTTP 400' });
    await expect(setup([{ errors: 'invalid input' }], [400]).client.list('accounts', 'customer', 'customer')).rejects.toMatchObject({ name: 'ProviderRequestError', reauth: false });
  });
  it.each([['2', 2000], ['120', 60000]] as const)('honors bounded Retry-After %s', async (header, wait) => {
    const { client, sleepImpl } = setup([{}, []], [429, 200], header);
    await expect(client.list('users', 'admin')).resolves.toEqual([]);
    expect(sleepImpl).toHaveBeenCalledWith(wait);
  });
  it('limits throttling to three retries, then fails the whole run', async () => {
    const { client, fetchImpl, sleepImpl } = setup([{}, {}, {}, {}], [429, 429, 429, 429], '0');
    await expect(client.list('accounts', 'customer', 'customer')).rejects.toMatchObject({ name: 'ProviderRequestError', reauth: false, code: 'http_429' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
  });
  it.each(['admin', 'customer'] as const)('retries exhausted %s 5xx calls', async (scope) => {
    const { client, fetchImpl } = setup([{}, {}, {}, {}], [503, 503, 503, 503]);
    await expect(client.list('accounts', 'access', scope)).rejects.toMatchObject({ name: scope === 'admin' ? 'ProviderRequestError' : 'CustomerRequestError', reauth: false, code: 'http_503' });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('retries network errors without leaking their message or cause', async () => {
    const { client, fetchImpl } = setup(Array.from({ length: 4 }, () => new Error('secret token')));
    const error = await client.list('users', 'admin').catch((e: unknown) => e);
    expect(error).toMatchObject({ reauth: false, code: 'network' });
    expect(String(error)).not.toContain('secret');
    expect(error).not.toHaveProperty('cause');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it('rejects non-JSON success and malformed envelopes as retryable', async () => {
    await expect(setup(['<html>oops</html>']).client.list('users', 'admin')).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
    await expect(setup([{}]).client.list('users', 'admin')).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
  });
});
describe('scrubTokens', () => {
  it('deep copies and redacts secret keys plus occurrences in other fields', () => {
    const input = { note: 'embedded-secret in text', nested: [{ authentication_token: 'embedded-secret', apiSecret: 'other-secret', text: 'admin other-secret' }], count: 3 };
    expect(scrubTokens(input, ['admin', ''])).toEqual({ note: '[redacted] in text', nested: [{ authentication_token: '[redacted]', apiSecret: '[redacted]', text: '[redacted] [redacted]' }], count: 3 });
    expect(input.nested[0]!.authentication_token).toBe('embedded-secret');
  });
});
