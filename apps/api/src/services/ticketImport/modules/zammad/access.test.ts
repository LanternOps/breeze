import { afterEach, describe, expect, it } from 'vitest';
import { SourceAuthError, SourceHttpError } from '../../sourceFetch';
import { catalogZammad, connectZammad, isZammad72 } from './access';
import { clearZammadDirectoryCache } from './directory';
import { buildSourceHandle } from '../../sourceHandle';
import { createSourceClient } from '../../sourceFetch';
import type { SafeFetchInit } from '../../../urlSafety';
import { FAKE_ZAMMAD_BASE_URL, FAKE_ZAMMAD_TOKEN, FakeZammad, zammadTestHandle } from './fakeZammad.fixtures';

/** Token, access and catalog (spec 2026-10-19 §6.1, §5.11 preflight). */

afterEach(() => clearZammadDirectoryCache());

describe('connect', () => {
  it('names the token user and its permissions, flags inactive and unreadable groups, and measures the clock skew', async () => {
    // The source clock runs 90 seconds ahead of Breeze's.
    const fake = new FakeZammad(undefined, { now: () => new Date(Date.now() + 90_000) });
    const report = await connectZammad(zammadTestHandle(fake));
    expect(report.identity).toEqual({ key: '2', name: 'Breeze Import', email: 'breeze-import@zammad.example.test' });
    expect(report.permissions).toEqual(['chat.agent', 'ticket.agent', 'user_preferences']);
    expect(report.warnings).toEqual([
      // Inactive groups are invisible to every token (Z1).
      { code: 'group_inactive', detail: 'Archive (id 4)' },
      // An active group the token user has no read access on.
      { code: 'group_unreadable', detail: 'Finance (id 5)' },
      // ticket.agent can still change users and organizations (Z11).
      { code: 'token_not_read_only' },
    ]);
    // The Date header has a one-second resolution.
    expect(report.clockSkewMs).toBeGreaterThan(88_000);
    expect(report.clockSkewMs).toBeLessThan(92_000);
    // The first live instance runs 7.2.0: any 7.2.x connects with no warning.
    expect(report.sourceVersion).toBe('7.2.0');
    expect(fake.requestedPaths()).toEqual([
      '/api/v1/tickets?page=1&per_page=1',
      '/api/v1/version',
      '/api/v1/users/me?expand=true',
      '/api/v1/roles?expand=true&page=1&per_page=1000',
      '/api/v1/groups?page=1&per_page=1000',
    ]);
  });

  it('reports the version: any 7.2.x without a warning; another one connects with a warning; none readable without admin', async () => {
    const versioned = async (version: string | null) => {
      const fake = new FakeZammad();
      fake.data.version = version === null ? null : { version };
      const report = await connectZammad(zammadTestHandle(fake));
      return { version: report.sourceVersion, codes: report.warnings.filter((w) => w.code.startsWith('version_')) };
    };
    expect(await versioned('7.2.2')).toEqual({ version: '7.2.2', codes: [] });
    expect(await versioned('7.2.1-1730000000.abc123.noble')).toEqual({ version: '7.2.1-1730000000.abc123.noble', codes: [] });
    expect(await versioned('7.1.3')).toEqual({ version: '7.1.3', codes: [{ code: 'version_unsupported', detail: '7.1.3' }] });
    expect(await versioned('8.0.0')).toEqual({ version: '8.0.0', codes: [{ code: 'version_unsupported', detail: '8.0.0' }] });
    // GET /version needs the exact admin permission: the recommended ticket.agent token gets 403.
    expect(await versioned(null)).toEqual({ version: null, codes: [{ code: 'version_unreadable' }] });
  });

  it('tells 7.2.x from look-alikes', () => {
    for (const v of ['7.2', '7.2.0', '7.2.2', ' 7.2.10 ', '7.2.0-1729.e9cb.focal']) expect(isZammad72(v)).toBe(true);
    for (const v of ['7.20.1', '7.3.0', '6.5.2', '17.2.0', '7.2x', 'unknown', '']) expect(isZammad72(v)).toBe(false);
  });

  it('refuses a token that is refused (401) or cannot read tickets (403)', async () => {
    await expect(connectZammad(zammadTestHandle(new FakeZammad(), { token: 'nope' }))).rejects.toBeInstanceOf(SourceAuthError);
    const fake = new FakeZammad();
    fake.failNext({ pathPrefix: '/api/v1/tickets', status: 403 });
    const refused = await connectZammad(zammadTestHandle(fake)).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SourceHttpError);
    expect((refused as SourceHttpError).status).toBe(403);
  });

  it('carries on when /users/me is not there (unverified in 7.2.2, §11) or roles are not readable', async () => {
    const noMe = new FakeZammad();
    noMe.failNext({ pathPrefix: '/api/v1/users/me', status: 404 });
    const report = await connectZammad(zammadTestHandle(noMe));
    expect(report.identity).toEqual({ key: null, name: null, email: null });
    expect(report.permissions).toEqual([]);
    expect(report.warnings.map((w) => w.code)).toEqual(['identity_unreadable', 'group_access_unknown', 'group_inactive', 'token_not_read_only']);
  });

  it('with roles unreadable, group access is unknown: one warning, no per-group guess, no readable:false in the catalog (review 3)', async () => {
    const noRoles = new FakeZammad();
    noRoles.failNext({ pathPrefix: '/api/v1/roles', status: 403 });
    const report = await connectZammad(zammadTestHandle(noRoles));
    expect(report.warnings.map((w) => w.code)).toEqual(['permissions_unreadable', 'group_access_unknown', 'group_inactive', 'token_not_read_only']);
    expect(report.permissions).toEqual([]);

    const catalogFake = new FakeZammad();
    catalogFake.failNext({ pathPrefix: '/api/v1/roles', status: 403 });
    const catalog = await catalogZammad(zammadTestHandle(catalogFake));
    expect(catalog.groups).toEqual([
      { key: '1', name: 'Users', active: true },
      { key: '2', name: 'Support', active: true },
      { key: '3', name: 'Support::Tier 2', active: true },
      // Inactive: invisible to every token, known without the roles.
      { key: '4', name: 'Archive', active: false, readable: false },
      { key: '5', name: 'Finance', active: true },
    ]);
  });

  it('optional lookups degrade to warnings, whatever their failure; only a refused credential fails connect (review 5)', async () => {
    const answer = (fake: FakeZammad, path: string, status: number, body: string) => {
      const original = fake.handle.bind(fake);
      fake.handle = (method, url, auth) => (url.pathname === path
        ? { status, headers: { 'content-type': 'application/json' }, body: Buffer.from(body) }
        : original(method, url, auth));
    };
    // /users/me of an unexpected shape, /roles failing after the retries, /groups not a list.
    const fake = new FakeZammad();
    answer(fake, '/api/v1/users/me', 200, '{"id":"not a number"}');
    answer(fake, '/api/v1/groups', 200, '{"groups":[]}');
    const report = await connectZammad(zammadTestHandle(fake));
    expect(report.warnings.map((w) => w.code)).toEqual(['identity_unreadable', 'group_access_unknown', 'groups_unreadable', 'token_not_read_only']);

    const outage = new FakeZammad();
    outage.failNext({ pathPrefix: '/api/v1/roles', status: 503, times: 3 });
    outage.failNext({ pathPrefix: '/api/v1/version', status: 502, times: 3 });
    const degraded = await connectZammad(zammadTestHandle(outage));
    expect(degraded.sourceVersion).toBeNull();
    expect(degraded.warnings.map((w) => w.code)).toEqual(['version_unreadable', 'permissions_unreadable', 'group_access_unknown', 'group_inactive', 'token_not_read_only']);

    // A refused credential on an optional lookup still stops connect.
    const refused = new FakeZammad();
    refused.failNext({ pathPrefix: '/api/v1/users/me', status: 401 });
    await expect(connectZammad(zammadTestHandle(refused))).rejects.toBeInstanceOf(SourceAuthError);
  });

  it('warns about a token user without ticket.agent and a token that sees no ticket', async () => {
    const fake = new FakeZammad();
    fake.data.roles = fake.data.roles.map((r) => (r.id === 2 ? { ...r, permissions: ['ticket.customer'] } : r));
    fake.data.tickets = [];
    const codes = (await connectZammad(zammadTestHandle(fake))).warnings.map((w) => w.code);
    expect(codes).toContain('token_user_not_agent');
    expect(codes).toContain('no_visible_tickets');
  });
});

describe('catalog', () => {
  it('lists orgs, groups (inactive and unreadable flagged), priorities, states with their types, and counts', async () => {
    const fake = new FakeZammad();
    const catalog = await catalogZammad(zammadTestHandle(fake));
    expect(catalog.orgs).toEqual([
      { key: '1', name: 'Zammad Foundation', active: true },
      { key: '2', name: 'Acme Ltd', active: true },
      { key: '3', name: 'Globex Inc', active: true },
      { key: '4', name: 'Initech', active: false },
    ]);
    expect(catalog.groups).toEqual([
      { key: '1', name: 'Users', active: true, readable: true },
      { key: '2', name: 'Support', active: true, readable: true },
      { key: '3', name: 'Support::Tier 2', active: true, readable: true },
      { key: '4', name: 'Archive', active: false, readable: false },
      { key: '5', name: 'Finance', active: true, readable: false },
    ]);
    expect(catalog.priorities.map((p) => p.name)).toEqual(['1 low', '2 normal', '3 high', '4 critical']);
    expect(catalog.states.map((s) => s.name)).toEqual([
      'new (new)', 'open (open)', 'pending reminder (pending reminder)', 'closed (closed)', 'merged (merged)',
      'pending close (pending action)', 'removed (removed)', 'Paused (pending action)',
    ]);
    // No admin.object: attribute names are discovered from tickets during the dry run.
    expect(catalog.attributes).toEqual([]);
    expect(catalog.counts).toEqual({
      organizations: 4, groups: 5, inactiveGroups: 1, users: 10, states: 8, priorities: 4, attributeDefinitionsReadable: 0, groupsReadable: 1, invalidRows: 0,
    });
  });

  it('within one preflight, reuses connect\'s token user and groups, and reads the rest concurrently (review 14)', async () => {
    const fake = new FakeZammad();
    let inFlight = 0;
    let peak = 0;
    const slow = async (url: string, init?: SafeFetchInit) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return fake.fetchImpl(url, init);
    };
    const http = createSourceClient(FAKE_ZAMMAD_BASE_URL, { timeoutMs: 5_000, concurrency: 2, fetchImpl: slow as never, sleep: async () => undefined });
    const src = buildSourceHandle({ sourceId: 'preflight', baseUrl: FAKE_ZAMMAD_BASE_URL, credentials: { token: FAKE_ZAMMAD_TOKEN }, options: {}, http });
    await connectZammad(src);
    peak = 0;
    await catalogZammad(src);
    const count = (path: string) => fake.requestedPaths().filter((p) => p.startsWith(path)).length;
    expect(count('/api/v1/users/me')).toBe(1);
    expect(count('/api/v1/roles')).toBe(1);
    expect(count('/api/v1/groups')).toBe(1);
    // Concurrent, and never past the source client's limit.
    expect(peak).toBe(2);
  });

  it('counts the users exactly, paging the index to its end two pages at a time (review 14)', async () => {
    const fake = new FakeZammad();
    const template = fake.data.users.find((u) => u.id === 10)!;
    fake.data.users = Array.from({ length: 2_500 }, (_, i) => ({ ...template, id: i + 1, login: `u${i + 1}` }));
    const catalog = await catalogZammad(zammadTestHandle(fake));
    expect(catalog.counts.users).toBe(2_500);
    // Pages 1 and 2, then 3 (short, the end) and 4 (read alongside it, ignored).
    expect(fake.requestedPaths().filter((p) => p.startsWith('/api/v1/users?')).sort()).toEqual([
      '/api/v1/users?page=1&per_page=1000', '/api/v1/users?page=2&per_page=1000',
      '/api/v1/users?page=3&per_page=1000', '/api/v1/users?page=4&per_page=1000',
    ]);
  });

  it('lists the custom ticket attributes when the token may read their definitions', async () => {
    const fake = new FakeZammad();
    const original = fake.handle.bind(fake);
    fake.handle = (method, url, auth) => {
      if (url.pathname === '/api/v1/object_manager_attributes') {
        const body = [
          { name: 'title', display: 'Title', object: 'Ticket', active: true, editable: false },
          { name: 'customer_reference', display: 'Customer reference', object: 'Ticket', active: true, editable: true },
          { name: 'department', display: 'Department', object: 'User', active: true, editable: true },
        ];
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) };
      }
      return original(method, url, auth);
    };
    const catalog = await catalogZammad(zammadTestHandle(fake));
    expect(catalog.attributes).toEqual([{ key: 'customer_reference', name: 'Customer reference', active: true }]);
    expect(catalog.counts.attributeDefinitionsReadable).toBe(1);
  });
});
