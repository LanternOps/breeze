import { describe, expect, it, vi } from 'vitest';
import type { OpaqueAccessToken } from './tokenClient';
import {
  GraphClientError,
  createMicrosoftGraphClient,
} from './graphClient';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const APPLICATION_ID = '22222222-2222-4222-8222-222222222222';
const APPLICATION_SP_ID = '33333333-3333-4333-8333-333333333333';
const RESOURCE_SP_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_RESOURCE_SP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GRAPH_APPLICATION_ID = '00000003-0000-0000-c000-000000000000';
const ROLE_ID = '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30';
const UNKNOWN_ROLE_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_ROLE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACCESS_TOKEN = 'opaque-secret-access-token' as OpaqueAccessToken;

type Route = {
  path: string;
  search?: Record<string, string>;
  response: Response | (() => Response | Promise<Response>);
};

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

function routes(overrides: Partial<{
  organization: unknown;
  application: unknown;
  assignments: unknown;
  resource: unknown;
}> = {}): Route[] {
  return [
    {
      path: '/v1.0/organization',
      search: { '$select': 'id,displayName' },
      response: json(overrides.organization ?? {
        value: [{ id: TENANT_ID, displayName: 'Contoso Ltd' }],
      }),
    },
    {
      path: `/v1.0/servicePrincipals(appId='${APPLICATION_ID}')`,
      search: { '$select': 'id,appId' },
      response: json('application' in overrides
        ? overrides.application
        : { id: APPLICATION_SP_ID, appId: APPLICATION_ID }),
    },
    {
      path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
      response: json(overrides.assignments ?? {
        value: [{ appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID }],
      }),
    },
    {
      path: `/v1.0/servicePrincipals/${RESOURCE_SP_ID}`,
      search: { '$select': 'appId,appRoles' },
      response: json(overrides.resource ?? {
        appId: GRAPH_APPLICATION_ID,
        appRoles: [{ id: ROLE_ID, value: 'Application.Read.All' }],
      }),
    },
  ];
}

function routeFetch(expectedRoutes: Route[]) {
  const remaining = [...expectedRoutes];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const expected = remaining.shift();
    expect(expected, `unexpected Graph request ${url.href}`).toBeDefined();
    expect(url.origin).toBe('https://graph.microsoft.com');
    expect(url.pathname).toBe(expected!.path);
    expect(Object.fromEntries(url.searchParams)).toEqual(expected!.search ?? {});
    expect(init).toMatchObject({
      method: 'GET',
      redirect: 'error',
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return typeof expected!.response === 'function'
      ? await expected!.response()
      : expected!.response;
  });
  return { fetch, assertComplete: () => expect(remaining).toEqual([]) };
}

function client(expectedRoutes = routes(), limits: Record<string, number> = {}) {
  const mock = routeFetch(expectedRoutes);
  return {
    graph: createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID, ...limits },
      { fetch: mock.fetch as typeof fetch },
    ),
    ...mock,
  };
}

describe('MicrosoftGraphClient', () => {
  it('uses only the four fixed GET families and returns tenant/application proof plus canonical grants', async () => {
    const { graph, fetch, assertComplete } = client();

    await expect(graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN })).resolves.toEqual({
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      organizationDisplayName: 'Contoso Ltd',
      observedGrants: [{
        resourceApplicationId: GRAPH_APPLICATION_ID,
        appRoleId: ROLE_ID,
        value: 'Application.Read.All',
      }],
    });

    expect(fetch).toHaveBeenCalledTimes(4);
    assertComplete();
  });

  it('requires the organization probe to contain exactly the requested tenant', async () => {
    const differentTenant = '66666666-6666-4666-8666-666666666666';
    for (const organization of [
      { value: [] },
      { value: [{ id: differentTenant, displayName: 'Wrong tenant' }] },
      { value: [
        { id: TENANT_ID, displayName: 'Contoso Ltd' },
        { id: differentTenant, displayName: 'Other' },
      ] },
    ]) {
      const { graph } = client(routes({ organization }));
      await expect(graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN }))
        .rejects.toMatchObject({ code: 'organization_probe_failed', message: 'organization_probe_failed' });
    }
  });

  it('strictly validates the fixed profile own-service-principal proof', async () => {
    for (const application of [
      null,
      [],
      { value: [{ id: APPLICATION_SP_ID, appId: APPLICATION_ID }] },
      { id: APPLICATION_SP_ID, appId: '88888888-8888-4888-8888-888888888888' },
      { id: 42, appId: APPLICATION_ID },
    ]) {
      const { graph } = client(routes({ application }));
      await expect(graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN }))
        .rejects.toMatchObject({ code: 'application_token_invalid', message: 'application_token_invalid' });
    }
  });

  it('preserves own-service-principal proof when assignment reconciliation is denied', async () => {
    const expected: Route[] = [
      {
        path: '/v1.0/organization',
        search: { '$select': 'id,displayName' },
        response: json({ value: [{ id: TENANT_ID, displayName: 'Contoso Ltd' }] }),
      },
      {
        path: `/v1.0/servicePrincipals(appId='${APPLICATION_ID}')`,
        search: { '$select': 'id,appId' },
        response: json({ id: APPLICATION_SP_ID, appId: APPLICATION_ID }),
      },
      {
        path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
        response: new Response('provider-secret', { status: 403 }),
      },
    ];
    const { graph, fetch, assertComplete } = client(expected);

    await expect(graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN })).resolves.toEqual({
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      organizationDisplayName: 'Contoso Ltd',
      observedGrants: null,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    assertComplete();
  });

  it('follows every valid assignment page and returns sorted unique grants', async () => {
    const pageTwo = `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=next`;
    const expected = routes();
    expected.splice(2, 2,
      {
        path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
        response: json({
          value: [{ appRoleId: UNKNOWN_ROLE_ID, resourceId: RESOURCE_SP_ID }],
          '@odata.nextLink': pageTwo,
        }),
      },
      {
        path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
        search: { '$skiptoken': 'next' },
        response: json({ value: [
          { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
          { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
        ] }),
      },
      {
        path: `/v1.0/servicePrincipals/${RESOURCE_SP_ID}`,
        search: { '$select': 'appId,appRoles' },
        response: json({
          appId: GRAPH_APPLICATION_ID,
          appRoles: [{ id: ROLE_ID, value: 'Application.Read.All' }],
        }),
      },
    );
    const { graph, assertComplete } = client(expected);

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toEqual([
      { resourceApplicationId: GRAPH_APPLICATION_ID, appRoleId: UNKNOWN_ROLE_ID, value: null },
      { resourceApplicationId: GRAPH_APPLICATION_ID, appRoleId: ROLE_ID, value: 'Application.Read.All' },
    ].sort((left, right) => `${left.resourceApplicationId}/${left.appRoleId}`.localeCompare(`${right.resourceApplicationId}/${right.appRoleId}`)));
    assertComplete();
  });

  it.each([
    ['plain HTTP', `http://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`],
    ['lookalike host', `https://graph.microsoft.com.evil.example/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`],
    ['userinfo', `https://attacker:@graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`],
    ['non-default port', `https://graph.microsoft.com:444/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`],
    ['fragment', `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x#secret`],
    ['different version', `https://graph.microsoft.com/beta/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`],
    ['path suffix confusion', `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments/extra?$skiptoken=x`],
    ['encoded path confusion', `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments%2fextra?$skiptoken=x`],
    ['different collection', 'https://graph.microsoft.com/v1.0/users?$skiptoken=x'],
  ])('rejects an unsafe @odata.nextLink: %s', async (_label, nextLink) => {
    const expected = routes({ assignments: {
      value: [{ appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID }],
      '@odata.nextLink': nextLink,
    } });
    expected.pop();
    const { graph, fetch } = client(expected);

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('enforces page, item, and cumulative response-byte bounds without returning partial grants', async () => {
    const nextLink = `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=x`;
    const cases: Array<{ limits: Record<string, number>; assignments: unknown }> = [
      { limits: { maxPageCount: 3 }, assignments: { value: [], '@odata.nextLink': nextLink } },
      { limits: { maxItemCount: 3 }, assignments: { value: [
        { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
        { appRoleId: UNKNOWN_ROLE_ID, resourceId: RESOURCE_SP_ID },
      ] } },
      { limits: { maxResponseBytes: 250 }, assignments: { value: [
        { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
      ] } },
    ];

    for (const { limits, assignments } of cases) {
      const expected = routes({ assignments });
      expected.pop();
      const { graph } = client(expected, limits);
      const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });
      expect(result.observedGrants).toBeNull();
    }
  });

  it('applies the item bound to resource app-role metadata as well as collection items', async () => {
    const expected = routes({ resource: {
      appId: GRAPH_APPLICATION_ID,
      appRoles: [
        { id: ROLE_ID, value: 'Application.Read.All' },
        { id: UNKNOWN_ROLE_ID, value: 'Unexpected.Read.All' },
      ],
    } });
    const { graph } = client(expected, { maxItemCount: 4 });

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toBeNull();
  });

  it('counts every paginated response against one probe-wide request boundary before fetching the next page', async () => {
    const pageTwo = `https://graph.microsoft.com/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments?$skiptoken=next`;
    const expected = routes();
    expected.splice(2, 2, {
      path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
      response: json({ value: [], '@odata.nextLink': pageTwo }),
    });
    const { graph, fetch } = client(expected, { maxPageCount: 3 });

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('counts singleton resource GETs against the same request boundary and rejects before the next request', async () => {
    const expected = routes();
    expected.splice(2, 2,
      {
        path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
        response: json({ value: [
          { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
          { appRoleId: SECOND_ROLE_ID, resourceId: SECOND_RESOURCE_SP_ID },
        ] }),
      },
      {
        path: `/v1.0/servicePrincipals/${RESOURCE_SP_ID}`,
        search: { '$select': 'appId,appRoles' },
        response: json({
          appId: GRAPH_APPLICATION_ID,
          appRoles: [{ id: ROLE_ID, value: 'Application.Read.All' }],
        }),
      },
    );
    const { graph, fetch } = client(expected, { maxPageCount: 4 });

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('shares one item budget across collection values and all resource app-role responses', async () => {
    const expected = routes();
    expected.splice(2, 2,
      {
        path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
        response: json({ value: [
          { appRoleId: ROLE_ID, resourceId: RESOURCE_SP_ID },
          { appRoleId: SECOND_ROLE_ID, resourceId: SECOND_RESOURCE_SP_ID },
        ] }),
      },
      {
        path: `/v1.0/servicePrincipals/${RESOURCE_SP_ID}`,
        search: { '$select': 'appId,appRoles' },
        response: json({
          appId: GRAPH_APPLICATION_ID,
          appRoles: [{ id: ROLE_ID, value: 'Application.Read.All' }],
        }),
      },
      {
        path: `/v1.0/servicePrincipals/${SECOND_RESOURCE_SP_ID}`,
        search: { '$select': 'appId,appRoles' },
        response: json({
          appId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          appRoles: [{ id: SECOND_ROLE_ID, value: 'Other.Read.All' }],
        }),
      },
    );
    const { graph, fetch, assertComplete } = client(expected, { maxItemCount: 5 });

    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });

    expect(result.observedGrants).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(5);
    assertComplete();
  });

  it('accepts exact cumulative request and item boundaries but rejects either boundary off by one', async () => {
    const exact = client(routes(), { maxPageCount: 4, maxItemCount: 4 });
    await expect(exact.graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN }))
      .resolves.toMatchObject({ observedGrants: [{ appRoleId: ROLE_ID }] });
    expect(exact.fetch).toHaveBeenCalledTimes(4);

    const requestOffByOneRoutes = routes();
    requestOffByOneRoutes.pop();
    const requestOffByOne = client(requestOffByOneRoutes, { maxPageCount: 3, maxItemCount: 4 });
    await expect(requestOffByOne.graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN }))
      .resolves.toMatchObject({ observedGrants: null });
    expect(requestOffByOne.fetch).toHaveBeenCalledTimes(3);

    const itemOffByOne = client(routes(), { maxPageCount: 4, maxItemCount: 3 });
    await expect(itemOffByOne.graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN }))
      .resolves.toMatchObject({ observedGrants: null });
    expect(itemOffByOne.fetch).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['assignment query denied', new Response('provider-secret', { status: 403 })],
    ['assignment object malformed', json({ value: [{ appRoleId: 42, resourceId: RESOURCE_SP_ID }] })],
    ['assignment body malformed', json({ value: 'not-an-array' })],
  ])('returns complete proof but no partial grants when %s', async (_label, response) => {
    const expected = routes();
    expected[2] = {
      path: `/v1.0/servicePrincipals/${APPLICATION_SP_ID}/appRoleAssignments`,
      response,
    };
    expected.pop();
    const { graph } = client(expected);

    await expect(graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN })).resolves.toEqual({
      tenantId: TENANT_ID,
      applicationId: APPLICATION_ID,
      organizationDisplayName: 'Contoso Ltd',
      observedGrants: null,
    });
  });

  it.each([
    ['resource query denied', new Response('provider-secret', { status: 403 })],
    ['resource app ID unavailable', json({ appRoles: [{ id: ROLE_ID, value: 'Application.Read.All' }] })],
    ['resource body malformed', json({ appId: GRAPH_APPLICATION_ID, appRoles: 'not-an-array' })],
  ])('returns no partial grants when %s', async (_label, response) => {
    const expected = routes();
    expected[3] = {
      path: `/v1.0/servicePrincipals/${RESOURCE_SP_ID}`,
      search: { '$select': 'appId,appRoles' },
      response,
    };
    const { graph } = client(expected);
    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });
    expect(result.observedGrants).toBeNull();
  });

  it('keeps an unknown role ID as a GUID-bearing observation with null display metadata', async () => {
    const { graph } = client(routes({
      assignments: { value: [{ appRoleId: UNKNOWN_ROLE_ID, resourceId: RESOURCE_SP_ID }] },
    }));
    const result = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN });
    expect(result.observedGrants).toEqual([{
      resourceApplicationId: GRAPH_APPLICATION_ID,
      appRoleId: UNKNOWN_ROLE_ID,
      value: null,
    }]);
  });

  it('uses abort timeouts and exposes only stable sanitized failures', async () => {
    const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error(`leaked ${ACCESS_TOKEN}`)));
    }));
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID, timeoutMs: 5 },
      { fetch: fetch as typeof globalThis.fetch },
    );

    const failure = await graph.probeTenant({ tenantId: TENANT_ID, accessToken: ACCESS_TOKEN })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GraphClientError);
    expect(failure).toMatchObject({ code: 'organization_probe_failed', message: 'organization_probe_failed' });
    expect(failure).not.toHaveProperty('cause');
    expect(JSON.stringify(failure)).not.toContain(ACCESS_TOKEN);
  });

  it.each([
    ['noncanonical tenant', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', ACCESS_TOKEN],
    ['empty access token', TENANT_ID, '' as OpaqueAccessToken],
  ])('rejects invalid fixed request input without network access: %s', async (_label, tenantId, accessToken) => {
    const { graph, fetch } = client([]);
    await expect(graph.probeTenant({ tenantId, accessToken })).rejects.toMatchObject({
      code: 'graph_request_invalid',
      message: 'graph_request_invalid',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function jsonResponder(body: unknown) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json(body));
}

function statusResponder(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  }));
}

function clientWithStatus(status: number, body: unknown, headers: Record<string, string> = {}) {
  return createMicrosoftGraphClient(
    { applicationId: APPLICATION_ID },
    { fetch: statusResponder(status, body, headers) as typeof fetch },
  );
}

function twoPageClient() {
  const nextLink = 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2';
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({
      value: [{ id: '1' }, { id: '2' }, { id: '3' }],
      '@odata.nextLink': nextLink,
    }))
    .mockResolvedValueOnce(json({
      value: [{ id: '4' }, { id: '5' }, { id: '6' }],
    }));
  return createMicrosoftGraphClient(
    { applicationId: APPLICATION_ID },
    { fetch: fetch as unknown as typeof globalThis.fetch },
  );
}

describe('graph read methods', () => {
  it('readResource projects nothing itself and returns the parsed object', async () => {
    const fetchStub = jsonResponder({ id: 'u1', displayName: 'Ada' });
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID },
      { fetch: fetchStub as unknown as typeof fetch },
    );
    const resource = await graph.readResource({
      accessToken: ACCESS_TOKEN,
      path: '/users/u1',
      select: ['id', 'displayName'],
    });
    expect(resource).toEqual({ id: 'u1', displayName: 'Ada' });
    expect(new URL(fetchStub.mock.calls[0]![0] as string).searchParams.get('$select')).toBe('id,displayName');
  });

  it('maps 403 to graph_permission_missing and license 403 to graph_license_required', async () => {
    await expect(clientWithStatus(403, { error: { code: 'Authorization_RequestDenied' } })
      .readResource({ accessToken: ACCESS_TOKEN, path: '/users/u1', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_permission_missing' });
    await expect(clientWithStatus(403, { error: { code: 'Authentication_RequestFromNonPremiumTenantOrB2CTenant' } })
      .readCollection({ accessToken: ACCESS_TOKEN, path: '/auditLogs/signIns', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_license_required' });
  });

  it('maps 404 to graph_not_found and 429 to graph_throttled with bounded retryAfterSeconds', async () => {
    await expect(clientWithStatus(404, {})
      .readResource({ accessToken: ACCESS_TOKEN, path: '/users/nope', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_not_found' });
    await expect(clientWithStatus(429, {}, { 'retry-after': '17' })
      .readCollection({ accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 17 });
  });

  it('clamps retryAfterSeconds to [1, 300] and defaults to 60 when the header is missing or invalid', async () => {
    await expect(clientWithStatus(429, {})
      .readCollection({ accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 60 });
    await expect(clientWithStatus(429, {}, { 'retry-after': '9000' })
      .readCollection({ accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 1 }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 300 });
  });

  it('maps other non-OK statuses to graph_provider_rejected', async () => {
    await expect(clientWithStatus(500, {})
      .readResource({ accessToken: ACCESS_TOKEN, path: '/users/u1', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_provider_rejected' });
  });

  it('truncates instead of throwing when maxItems is reached before nextLink is exhausted', async () => {
    const result = await twoPageClient().readCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 4, maxPages: 5,
    });
    expect(result.items).toHaveLength(4);
    expect(result.truncated).toBe(true);
  });

  it('truncates instead of throwing when maxPages is reached with more pages remaining', async () => {
    const result = await twoPageClient().readCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 100, maxPages: 1,
    });
    expect(result.items).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('does not truncate when every page fits within maxItems and maxPages', async () => {
    const result = await twoPageClient().readCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 100, maxPages: 5,
    });
    expect(result.items).toHaveLength(6);
    expect(result.truncated).toBe(false);
  });

  it('sets ConsistencyLevel header and passes query through only when consistencyLevelEventual', async () => {
    const fetchStub = jsonResponder({ value: [] });
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID },
      { fetch: fetchStub as unknown as typeof fetch },
    );
    await graph.readCollection({
      accessToken: ACCESS_TOKEN,
      path: '/users',
      query: { '$search': '"displayName:ada"' },
      consistencyLevelEventual: true,
      maxItems: 10,
      maxPages: 1,
    });
    const [url, init] = fetchStub.mock.calls[0]!;
    expect(new URL(url as string).searchParams.get('$search')).toBe('"displayName:ada"');
    expect((init as RequestInit).headers).toMatchObject({ ConsistencyLevel: 'eventual' });
  });

  it('omits the ConsistencyLevel header when consistencyLevelEventual is not set', async () => {
    const fetchStub = jsonResponder({ value: [] });
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID },
      { fetch: fetchStub as unknown as typeof fetch },
    );
    await graph.readCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 1,
    });
    const [, init] = fetchStub.mock.calls[0]!;
    expect((init as RequestInit).headers).not.toHaveProperty('ConsistencyLevel');
  });

  it('rejects a path that does not start with a slash without making a network call', async () => {
    const fetchStub = jsonResponder({});
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID },
      { fetch: fetchStub as unknown as typeof fetch },
    );
    await expect(graph.readResource({ accessToken: ACCESS_TOKEN, path: 'users/u1', select: ['id'] }))
      .rejects.toMatchObject({ code: 'graph_request_invalid' });
    await expect(graph.readCollection({
      accessToken: ACCESS_TOKEN, path: 'users', query: {}, maxItems: 10, maxPages: 1,
    })).rejects.toMatchObject({ code: 'graph_request_invalid' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('rejects an unsafe @odata.nextLink for readCollection reusing fixedCollectionNextLink', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json({
        value: [{ id: '1' }],
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/differentCollection?$skiptoken=x',
      }));
    const graph = createMicrosoftGraphClient(
      { applicationId: APPLICATION_ID },
      { fetch: fetch as unknown as typeof globalThis.fetch },
    );
    await expect(graph.readCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: {}, maxItems: 10, maxPages: 5,
    })).rejects.toMatchObject({ code: 'graph_response_invalid' });
  });
});

describe('readSyncCollection', () => {
  const USERS_PATH = '/v1.0/users';
  // A comfortably distant deadline for tests that don't exercise deadline
  // behavior themselves. Deliberately relative to the real clock (not a bare
  // epoch-ms literal): readSyncCollection's default `now` is real Date.now(),
  // so an absolute constant like `10_000_000` (2h46m after the 1970 epoch) is
  // already "in the past" and would make every non-deadline test stop
  // immediately with zero pages.
  const DEADLINE = Date.now() + 10_000_000;

  function pagedFetch(pages: Array<{ value: unknown[]; next?: string }>) {
    let index = 0;
    return vi.fn(async (_url: string, _init?: RequestInit) => {
      const page = pages[index++];
      if (!page) throw new Error('fetched more pages than the fixture defines');
      return json(page.next === undefined
        ? { value: page.value }
        : { value: page.value, '@odata.nextLink': page.next });
    });
  }

  function syncClient(fetchImpl: typeof fetch, extra: { sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => number } = {}) {
    return createMicrosoftGraphClient({ applicationId: APPLICATION_ID }, { fetch: fetchImpl, ...extra });
  }

  const limits = (over: Partial<Parameters<ReturnType<typeof syncClient>['readSyncCollection']>[0]['limits']> = {}) => ({
    maxItems: 1_000, maxPages: 60, maxResponseBytes: 64 * 1024 * 1024, deadlineAt: DEADLINE, ...over,
  });

  it('walks every page and reports completion', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
      { value: [{ id: 'b' }] },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', query: { '$top': '999' }, limits: limits(),
    });
    expect(result.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(result.stopReason).toBe('complete');
    expect(result.nextLink).toBeUndefined();
    expect(result.pages).toBe(2);
  });

  it('stops at maxPages and hands back the resume link', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
      { value: [{ id: 'b' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=2` },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxPages: 2 }),
    });
    expect(result.stopReason).toBe('max_pages');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=2`);
    expect(result.items).toHaveLength(2);
  });

  it('stops at maxItems mid-page and drops the overflow', async () => {
    const fetchImpl = pagedFetch([{ value: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxItems: 2 }),
    });
    expect(result.stopReason).toBe('max_items');
    expect(result.items).toHaveLength(2);
  });

  it('pauses before a page when beforePage refuses, returning the resume link', async () => {
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
    ]);
    let allowed = 1;
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), beforePage: () => allowed-- > 0,
    });
    expect(result.stopReason).toBe('paused');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=1`);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('pauses before the FIRST page with zero items when the bucket is already empty', async () => {
    const fetchImpl = vi.fn();
    const result = await syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), beforePage: () => false,
    });
    expect(result).toMatchObject({ items: [], stopReason: 'paused', pages: 0 });
    expect(result.nextLink).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resumes from a validated startUrl and refuses one pointing anywhere else', async () => {
    const fetchImpl = pagedFetch([{ value: [{ id: 'z' }] }]);
    const client = syncClient(fetchImpl as unknown as typeof fetch);
    const resumed = await client.readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(),
      startUrl: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=9`,
    });
    expect(resumed.items).toEqual([{ id: 'z' }]);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=9`);

    for (const bad of [
      'https://evil.example.test/v1.0/users?$skiptoken=9',
      'https://graph.microsoft.com/v1.0/deviceManagement/managedDevices',
      'http://graph.microsoft.com/v1.0/users',
    ]) {
      await expect(client.readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/users', limits: limits(), startUrl: bad,
      })).rejects.toMatchObject({ code: 'graph_response_invalid' });
    }
  });

  it('honours Retry-After on 429 and succeeds on the retry', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' } }))
      .mockResolvedValueOnce(json({ value: [{ id: 'a' }] }));
    const result = await syncClient(fetchImpl as unknown as typeof fetch, {
      sleep: async (ms) => { slept.push(ms); },
    }).readSyncCollection({ accessToken: ACCESS_TOKEN, path: '/users', limits: limits() });
    expect(slept).toEqual([7_000]);
    expect(result.items).toEqual([{ id: 'a' }]);
  });

  it('gives up after maxAttempts and surfaces graph_throttled with retryAfterSeconds', async () => {
    const slept: number[] = [];
    const throttled = () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '5' } });
    const fetchImpl = vi.fn().mockResolvedValue(throttled());
    await expect(syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({ accessToken: ACCESS_TOKEN, path: '/users', limits: limits() }))
      .rejects.toMatchObject({ code: 'graph_throttled', retryAfterSeconds: 5 });
    expect(slept).toEqual([5_000, 5_000]); // 3 attempts ⇒ 2 sleeps
  });

  it('stops sleeping once the cumulative throttle budget is spent', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{}', { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '90' } }),
    );
    await expect(syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/users',
        limits: limits({ retry: { maxAttempts: 3, cumulativeBudgetMs: 60_000 } }),
      }))
      .rejects.toMatchObject({ code: 'graph_throttled' });
    expect(slept).toEqual([]); // 90 s > the 60 s budget: never sleep, fail immediately
  });

  it('uses a fixed backoff when the policy sets one — CA policies send no Retry-After', async () => {
    const slept: number[] = [];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(json({ value: [{ id: 'p' }] }));
    await syncClient(fetchImpl as unknown as typeof fetch, { sleep: async (ms) => { slept.push(ms); } })
      .readSyncCollection({
        accessToken: ACCESS_TOKEN, path: '/identity/conditionalAccess/policies',
        limits: limits({ retry: { maxAttempts: 3, cumulativeBudgetMs: 60_000, fixedBackoffMs: 2_000 } }),
      });
    expect(slept).toEqual([2_000]); // NOT the 60 s Retry-After default
  });

  it('stops between pages when the remaining deadline cannot fit another request', async () => {
    let clock = 0;
    const fetchImpl = pagedFetch([
      { value: [{ id: 'a' }], next: `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` },
    ]);
    const result = await syncClient(fetchImpl as unknown as typeof fetch, {
      now: () => { clock += 25_000; return clock; },
    }).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users',
      limits: limits({ deadlineAt: 40_000, perRequestTimeoutMs: 30_000 }),
    });
    expect(result.stopReason).toBe('deadline');
    expect(result.nextLink).toBe(`https://graph.microsoft.com${USERS_PATH}?$skiptoken=1`);
  });

  it('aborts an in-flight request when the hard deadline passes', async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users',
      limits: limits({ deadlineAt: Date.now() + 20, perRequestTimeoutMs: 30_000 }),
    })).rejects.toMatchObject({ code: 'graph_request_timeout' });
  });

  it('bounds the cumulative response size across pages', async () => {
    const big = { value: [{ id: 'a', blob: 'x'.repeat(4_000) }], '@odata.nextLink': `https://graph.microsoft.com${USERS_PATH}?$skiptoken=1` };
    const fetchImpl = vi.fn(async () => json(big));
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits({ maxResponseBytes: 5_000 }),
    })).rejects.toMatchObject({ code: 'graph_response_too_large' });
  });

  it('maps 403 to graph_permission_missing without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'Authorization_RequestDenied' } }), {
        status: 403, headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(syncClient(fetchImpl as unknown as typeof fetch).readSyncCollection({
      accessToken: ACCESS_TOKEN, path: '/users', limits: limits(),
    })).rejects.toMatchObject({ code: 'graph_permission_missing' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
