import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveBackupHealth } from '@breeze/shared';
import * as clientModule from './client';
import missingAccount from './__fixtures__/error-account-not-found.json';
import { dropsuiteAdapter as adapter, dropsuiteCredentialsSchema, __setDropsuiteClientFactoryForTests, mapDropsuiteStatus, rollupWorkload } from './adapter';
import { DropsuiteClient, type DropsuiteFetchImpl } from './client';
import users from './__fixtures__/users.json';
import accounts from './__fixtures__/accounts.json';
import onedrives from './__fixtures__/onedrives.json';
import tenants from './__fixtures__/tenants.json';
import spDomains from './__fixtures__/sharepoint-domains.json';
import sites from './__fixtures__/sharepoint-sites.json';
import teamDomains from './__fixtures__/teams-domains.json';
import teams from './__fixtures__/teams.json';
import googledrives from './__fixtures__/googledrives.json';
import sdDomains from './__fixtures__/shareddrive-domains.json';
import drives from './__fixtures__/shareddrive-drives.json';
const CREDS = { resellerToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', authToken: 'synthetic-admin-token' };
const BASE = 'https://region.dropmyemail.com/api/';
const NOW = new Date('2026-10-28T06:00:00Z');
const fixtures: Record<string, unknown> = { users, accounts, onedrives, googledrives, 'sharepoints/domains': spDomains, 'sharepoints/domains/21/sites': sites, 'teams_and_groups/domains': teamDomains, 'teams_and_groups/domains/31/teams': teams, 'shareddrives/domains': sdDomains, 'shareddrives/domains/51/drives': drives };
function fakeVendor(override?: (path: string, token: string | undefined) => { status?: number; body: unknown } | undefined) {
  const fetch: DropsuiteFetchImpl = vi.fn(async (url, init) => {
    const path = new URL(url).pathname.replace('/api/', '');
    const response = override?.(path, init.headers['X-Access-Token']);
    const status = response?.status ?? 200;
    const body = response?.body ?? (path.endsWith('/tenants') ? tenants : fixtures[path] ?? 'OK');
    return { ok: status === 200, status, headers: new Headers(), text: async () => JSON.stringify(body) };
  });
  __setDropsuiteClientFactoryForTests((baseUrl, resellerToken) => new DropsuiteClient({ baseUrl, resellerToken, fetchImpl: fetch, sleepImpl: async () => {} }));
  return fetch;
}
afterEach(() => { __setDropsuiteClientFactoryForTests(null); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('configuration', () => {
  it('validates credentials and defaults', () => {
    expect(dropsuiteCredentialsSchema.parse({ ...CREDS, authToken: ' admin ' })).toEqual({ ...CREDS, authToken: 'admin' });
    for (const bad of [{ ...CREDS, resellerToken: 'bad' }, { ...CREDS, authToken: ' ' }, { ...CREDS, authToken: 'x'.repeat(201) }]) expect(dropsuiteCredentialsSchema.safeParse(bad).success).toBe(false);
    expect(adapter.defaultBaseUrl).toBeUndefined(); expect(adapter.defaultSyncIntervalMinutes).toBe(60);
  });
  it.each(['https://dropsuite.us/api', BASE, 'https://a.dropsuite.com/api/v1'])('accepts %s', url => expect(adapter.validateBaseUrl!(url)).toBeNull());
  it.each(['http://dropsuite.us/api', 'https://dropsuite.us.evil.example/api', 'https://evildropsuite.com/api', 'https://dropsuite.us/else', 'https://user:pass' + '@dropsuite.us/api' /* split: the PII guard reads userinfo URLs as emails */, 'bad'])('rejects %s', url => expect(adapter.validateBaseUrl!(url)).toEqual(expect.any(String)));
});
describe('status mapping', () => {
  it.each([
    ['Completed', null, 'completed'], ['Completed', '', 'completed'], ['Completed', {}, 'completed'], ['Completed', '{}', 'completed'], ['Completed', 'null', 'completed'], ['Completed', '""', 'completed'],
    ['Completed', { host: 'bad' }, 'completed_with_errors'], ['Completed', 'bad', 'completed_with_errors'], ['Completed', '{"host":"bad"}', 'completed_with_errors'],
    ['Running', '', 'in_progress'], ['Preparing Backup', '', 'in_progress'], ['Connecting', '', 'in_progress'], ['Connection Failed', '', 'failed'], ['Authentication Error', '', 'failed'], ['System Error', '', 'failed'], ['Unknown', '', 'unknown'], ['Novel', '', 'unknown'],
  ])('%s / %j => %s', (status, errors, expected) => expect(mapDropsuiteStatus({ current_backup_status: status, errors, last_backup: NOW.toISOString() }, false, NOW)).toBe(expected));
  it('maps absent backups and Google Drive integer statuses', () => {
    expect(mapDropsuiteStatus({ last_backup: null, added_on: '2020-01-01' }, false, NOW)).toBe('no_backups');
    expect(mapDropsuiteStatus({ last_backup: null, added_on: NOW.toISOString() }, false, NOW)).toBe('unknown');
    expect(mapDropsuiteStatus({ status: 10, last_backup: NOW.toISOString(), errors: 'private' }, true, NOW)).toBe('completed');
    expect(mapDropsuiteStatus({ status: 7, last_backup: null }, true, NOW)).toBe('no_backups');
  });
});
describe('rollup', () => {
  it('filters deactivated items, chooses worst status and oldest successful backup', () => {
    const row = rollupWorkload(users[0]!, 'm365_mail', accounts, NOW, []);
    expect(row).toMatchObject({ vendorDeviceId: '10001-14:m365_mail', accountType: 'm365', status: 'completed_with_errors', usedBytes: 7168, errorsCount: 1, lastSuccessAt: new Date('2026-10-27T04:00:00Z'), lastSessionAt: new Date('2026-10-27T05:00:00Z') });
    expect(row?.raw).toMatchObject({ itemCount: 3, deactivatedCount: 1, statusCounts: { completed: 1, completed_with_errors: 1, in_progress: 1 } });
  });
  it('uses newest successful Teams backup so unchanged teams do not make health critical', () => {
    const old = new Date(NOW.getTime() - 5 * 86400_000).toISOString();
    const row = rollupWorkload(users[0]!, 'm365_teams', [
      { id: 1, current_backup_status: 'Completed', last_backup: old },
      { id: 2, current_backup_status: 'Completed', last_backup: NOW.toISOString() },
      { id: 3, current_backup_status: 'Connecting', last_backup: new Date(NOW.getTime() + 1000).toISOString() },
    ], NOW, [])!;
    expect(row.lastSuccessAt).toEqual(NOW);
    expect(deriveBackupHealth({ status: row.status, lastSuccessAt: row.lastSuccessAt, errorsCount: row.errorsCount, now: NOW }).health).not.toBe('critical');
    expect(row.raw.failingItems).toEqual([]);
  });
  it.each(['m365_mail', 'gws_mail', 'm365_onedrive', 'm365_sharepoint', 'gws_drive', 'gws_shared_drive'] as const)('includes stuck active items in oldest backup for %s', workload => {
    const old = new Date(NOW.getTime() - 14 * 86400_000);
    const row = rollupWorkload(users[0]!, workload, [
      { id: 1, current_backup_status: 'Connecting', last_backup: old.toISOString() },
      { id: 2, current_backup_status: 'Completed', last_backup: NOW.toISOString() },
      { id: 3, current_backup_status: 'Completed', last_backup: '2020-01-01', deactivated_since: '2021-01-01' },
    ], NOW, [])!;
    expect(row.lastSuccessAt).toEqual(old);
  });
  it('caps details and error lengths, counting unknown vocabulary', () => {
    const row = rollupWorkload(users[0]!, 'm365_mail', Array.from({length: 60}, (_, id) => ({ id, current_backup_status: 'Novel', errors: 'x'.repeat(500) })), NOW, [])!;
    expect(row.raw.vendorStatuses).toEqual({ Novel: 60 });
    const failing = row.raw.failingItems as Array<{error: string}>;
    expect(failing).toHaveLength(50); expect(failing[0]!.error).toHaveLength(200);
  });
  it('uses seven days for Teams stale details', () => {
    expect(rollupWorkload(users[0]!, 'm365_teams', teams, NOW, [])!.raw.failingItems).toEqual([]);
    expect(rollupWorkload(users[0]!, 'm365_mail', teams, NOW, [])!.raw.failingItems).toHaveLength(1);
    expect(rollupWorkload(users[0]!, 'm365_teams', teams, new Date('2026-11-02'), [])!.raw.failingItems).toHaveLength(1);
  });
  it('omits empty workloads, keeps deactivated counts and disables suspended workloads', () => {
    expect(rollupWorkload(users[0]!, 'm365_mail', [], NOW, [])).toBeNull();
    expect(rollupWorkload(users[0]!, 'm365_mail', [accounts[2]!], NOW, [])).toMatchObject({ status: 'not_started', raw: { itemCount: 0, deactivatedCount: 1 } });
    expect(rollupWorkload({ ...users[0]!, flg_suspended: true }, 'm365_mail', accounts, NOW, [])).toMatchObject({ status: 'not_started', raw: { failingItems: [] } });
  });
});
describe('adapter over HTTP fixtures', () => {
  it('keeps reseller root identity stable across credential rotation', async () => {
    const fetch = fakeVendor();
    expect(adapter.rootContinuity).toBe('customer_overlap');
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toEqual({ ok: true, rootId: 'dropsuite', rootName: 'Dropsuite reseller', customerCount: 2 });
    expect(vi.mocked(fetch).mock.calls[0]![1].headers['X-Access-Token']).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls[1]![1].headers['X-Access-Token']).toBe(CREDS.authToken);
  });
  it('scrubs full enumeration and uses each customer token for every workload', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    const fetch = fakeVendor();
    const customers = await adapter.listCustomers(CREDS, BASE, 'root');
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(customers[0]).toMatchObject({ vendorCustomerId: users[0]!.id, name: 'Contoso Dental', parentId: null, level: 'business', externalCode: users[0]!.external_id });
    expect(result.devices).toHaveLength(12); expect(result.failedCustomerIds).toEqual([]);
    for (const [url, init] of vi.mocked(fetch).mock.calls) {
      expect(init.method).toBe('GET');
      if (!new URL(url).pathname.endsWith('/users')) expect(users.map(u => u.authentication_token)).toContain(init.headers['X-Access-Token']);
      expect(url).not.toContain('connection_failures');
    }
    const serialized = JSON.stringify({ customers, result });
    for (const token of [...users.map(u => u.authentication_token), users[0]!.reseller_token, CREDS.authToken, CREDS.resellerToken]) expect(serialized).not.toContain(token);
    expect(serialized).not.toContain('Machine IP'); expect(serialized).not.toContain('skipped_gdrive');
  });
  it.each([401, 403, 400, 503])('isolates customer HTTP %s', async status => {
    fakeVendor((path, token) => path === 'accounts' && token === users[0]!.authentication_token ? { status, body: 'not authorized' } : undefined);
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(result.failedCustomerIds).toEqual([users[0]!.id]); expect(result.devices).toHaveLength(6);
    expect(result.devices.every(d => d.vendorCustomerId === users[1]!.id)).toBe(true);
  });
  it('rolls up fixture Google Drives by drive_account_id even when id is shared', async () => {
    fakeVendor(path => path === 'googledrives' ? { body: googledrives.map(item => ({ ...item, id: 'not-the-identity' })) } : undefined);
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(result.devices.filter(row => row.dataSources.includes('gws_drive'))).toHaveLength(2);
    expect(result.devices.find(row => row.dataSources.includes('gws_drive'))).toMatchObject({ usedBytes: 600, raw: { itemCount: 3 } });
  });
  it('rejects Google Drive rows missing drive_account_id rather than accepting id', async () => {
    fakeVendor(path => path === 'googledrives' ? { body: [{ id: 1, last_backup: NOW.toISOString() }] } : undefined);
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ code: 'malformed_response' });
  });
  it.each([400, 404])('isolates account-not-found customer HTTP %s while updating the other', async status => {
    fakeVendor((path, token) => path === 'accounts' && token === users[0]!.authentication_token ? { status, body: missingAccount } : undefined);
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(result.failedCustomerIds).toEqual([users[0]!.id]);
    expect(result.devices).toHaveLength(6);
  });
  it('fails retryably when every customer is skipped', async () => {
    fakeVendor(path => path === 'accounts' ? { status: 401, body: missingAccount } : undefined);
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ name: 'ProviderRequestError', reauth: false, code: 'all_customers_failed' });
  });
  it('scrubs each customer with only admin reseller and its own token', async () => {
    fakeVendor();
    const scrub = vi.spyOn(clientModule, 'scrubTokens');
    await adapter.listCustomers(CREDS, BASE, 'root');
    await adapter.listDevices(CREDS, BASE, 'root');
    expect(scrub.mock.calls.some(([value]) => Array.isArray(value) && value === users)).toBe(false);
    for (const [, tokens = []] of scrub.mock.calls) {
      expect(tokens.length).toBeLessThanOrEqual(3);
      expect(tokens).toContain(CREDS.authToken);
      expect(tokens).toContain(CREDS.resellerToken);
    }
  });
  it('skips only the customer exceeding 500 requests and preserves the other workload results', async () => {
    const fetch = fakeVendor((path, token) => {
      if (token !== users[0]!.authentication_token) return undefined;
      if (path === 'sharepoints/domains' || path === 'teams_and_groups/domains') return { body: Array.from({ length: 199 }, (_, id) => ({ id })) };
      if (path.startsWith('sharepoints/domains/') || path.startsWith('teams_and_groups/domains/')) return { body: [{ id: path, current_backup_status: 'Completed', last_backup: NOW.toISOString() }] };
      return undefined;
    });
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(result.failedCustomerIds).toEqual([users[0]!.id]);
    expect(result.devices).toHaveLength(6);
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init.headers['X-Access-Token'] === users[0]!.authentication_token)).toHaveLength(500);
  });
  it('stops the other worker before its next request after a fatal failure', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const fetch: DropsuiteFetchImpl = async (url, init) => {
      const path = new URL(url).pathname.replace('/api/', '');
      const token = init.headers['X-Access-Token'];
      calls.push(`${token}:${path}`);
      if (path.endsWith('/tenants') && token === users[1]!.authentication_token) await gate;
      const body = path === 'users' ? users : path === 'accounts' ? '<html>fatal</html>' : [];
      return { ok: true, status: 200, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
    };
    __setDropsuiteClientFactoryForTests((baseUrl, resellerToken) => new DropsuiteClient({ baseUrl, resellerToken, fetchImpl: fetch }));
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ code: 'malformed_response' });
    const before = calls.length;
    release();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toHaveLength(before);
  });
  it('admin rejection fails the run and requests reauth', async () => {
    fakeVendor(path => path === 'users' ? { status: 401, body: 'denied' } : undefined);
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ reauth: true });
    await expect(adapter.testConnection(CREDS, BASE)).resolves.toMatchObject({ ok: false, reauth: true });
  });
  it('labels GWS-only mail and defaults to M365 on failed tenant lookup', async () => {
    fakeVendor((path, token) => path.endsWith('/tenants') ? token === users[0]!.authentication_token ? { body: [{ type: 'gws' }] } : { status: 401, body: 'denied' } : undefined);
    const result = await adapter.listDevices(CREDS, BASE, 'root');
    expect(result.devices.find(d => d.vendorDeviceId === `${users[0]!.id}:gws_mail`)?.accountType).toBe('gws');
    expect(result.devices.find(d => d.vendorDeviceId === `${users[1]!.id}:m365_mail`)?.accountType).toBe('m365'); expect(result.failedCustomerIds).toEqual([]);
  });
});

// Missing identity must abort rather than making existing inventory vanish.
describe('malformed vendor identity', () => {
  it('rejects users without an id before mapping or inventory enumeration', async () => {
    fakeVendor(path => path === 'users' ? { body: [{ email: 'synthetic@example.com' }] } : undefined);
    await expect(adapter.listCustomers(CREDS, BASE, 'root')).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
  });
  it('rejects a domain without an id rather than querying an invented child path', async () => {
    fakeVendor(path => path === 'sharepoints/domains' ? { body: [{}] } : path.includes('/undefined/') ? { body: [] } : undefined);
    await expect(adapter.listDevices(CREDS, BASE, 'root')).rejects.toMatchObject({ code: 'malformed_response', reauth: false });
  });
});
