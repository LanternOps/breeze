import { describe, expect, it } from 'vitest';
import {
  M365_READ_ACTION_FIELDS,
  M365_READ_ACTION_IDS,
  type M365ReadAction,
  type M365ReadActionId,
} from '@breeze/shared/m365';
import { GraphClientError, type MicrosoftGraphClient } from './graphClient';
import { executeGraphReadAction } from './readActions';
import type { OpaqueAccessToken } from './tokenClient';

const ACCESS_TOKEN = 'opaque-test-access-token' as OpaqueAccessToken;
const NOW = () => new Date('2026-07-18T00:00:00Z');
const DEVICE_ID = '11111111-1111-4111-8111-111111111111';
const GROUP_ID = '22222222-2222-4222-8222-222222222222';
const SITE_ID = 'contoso.sharepoint.com,aaaaaaaa-1111-2222-3333-444444444444,bbbbbbbb-1111-2222-3333-444444444444';

type ReadResourceCall = { accessToken: OpaqueAccessToken; path: string; select: readonly string[] };
type ReadCollectionCall = {
  accessToken: OpaqueAccessToken;
  path: string;
  query: Record<string, string>;
  consistencyLevelEventual?: boolean;
  maxItems: number;
  maxPages: number;
};

function createStubGraphClient(options: {
  resource?: Record<string, unknown>;
  collection?: { items: Record<string, unknown>[]; truncated: boolean };
  throwError?: GraphClientError;
} = {}): {
  client: MicrosoftGraphClient;
  readResourceCalls: ReadResourceCall[];
  readCollectionCalls: ReadCollectionCall[];
} {
  const readResourceCalls: ReadResourceCall[] = [];
  const readCollectionCalls: ReadCollectionCall[] = [];
  const client: MicrosoftGraphClient = {
    async probeTenant() {
      throw new Error('probeTenant is not used by readActions');
    },
    async readResource(input) {
      readResourceCalls.push(input);
      if (options.throwError) throw options.throwError;
      return options.resource ?? { id: 'stub-resource-id' };
    },
    async readCollection(input) {
      readCollectionCalls.push(input);
      if (options.throwError) throw options.throwError;
      return options.collection ?? { items: [{ id: 'stub-item-id' }], truncated: false };
    },
  };
  return { client, readResourceCalls, readCollectionCalls };
}

// One minimal valid action per id, and the exact fixed path each must hit.
const SAMPLE_ACTIONS: Record<M365ReadActionId, M365ReadAction> = {
  'm365.user.list': { type: 'm365.user.list' },
  'm365.user.get': { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
  'm365.signins.list': { type: 'm365.signins.list' },
  'm365.intune.device.list': { type: 'm365.intune.device.list' },
  'm365.intune.device.get': { type: 'm365.intune.device.get', deviceId: DEVICE_ID },
  'm365.group.list': { type: 'm365.group.list' },
  'm365.group.get': { type: 'm365.group.get', groupId: GROUP_ID },
  'm365.group.members.list': { type: 'm365.group.members.list', groupId: GROUP_ID },
  'm365.org.get': { type: 'm365.org.get' },
  'm365.org.skus.list': { type: 'm365.org.skus.list' },
  'm365.sites.list': { type: 'm365.sites.list', search: 'intranet' },
  'm365.site.get': { type: 'm365.site.get', siteId: SITE_ID },
};

const EXPECTED_PATH: Record<M365ReadActionId, string> = {
  'm365.user.list': '/users',
  'm365.user.get': `/users/${encodeURIComponent('ada@contoso.com')}`,
  'm365.signins.list': '/auditLogs/signIns',
  'm365.intune.device.list': '/deviceManagement/managedDevices',
  'm365.intune.device.get': `/deviceManagement/managedDevices/${encodeURIComponent(DEVICE_ID)}`,
  'm365.group.list': '/groups',
  'm365.group.get': `/groups/${encodeURIComponent(GROUP_ID)}`,
  'm365.group.members.list': `/groups/${encodeURIComponent(GROUP_ID)}/members`,
  'm365.org.get': '/organization',
  'm365.org.skus.list': '/subscribedSkus',
  'm365.sites.list': '/sites',
  'm365.site.get': `/sites/${encodeURIComponent(SITE_ID)}`,
};

// Actions dispatched via graphClient.readResource (single-object fetch).
// Everything else — including m365.org.get, which projects the collection's
// first item into a `resource` result — goes through readCollection.
const RESOURCE_ACTION_IDS = new Set<M365ReadActionId>([
  'm365.user.get',
  'm365.intune.device.get',
  'm365.group.get',
  'm365.site.get',
]);

describe('executeGraphReadAction — dispatch table', () => {
  it.each(M365_READ_ACTION_IDS)('%s calls the fixed path with the full field allowlist as $select', async (actionId) => {
    const { client, readResourceCalls, readCollectionCalls } = createStubGraphClient();
    const action = SAMPLE_ACTIONS[actionId];
    const fields = M365_READ_ACTION_FIELDS[actionId];

    const result = await executeGraphReadAction(action, { accessToken: ACCESS_TOKEN, graphClient: client, now: NOW });

    expect(result.success).toBe(true);
    if (RESOURCE_ACTION_IDS.has(actionId)) {
      expect(readCollectionCalls).toHaveLength(0);
      expect(readResourceCalls).toHaveLength(1);
      expect(readResourceCalls[0]!.path).toBe(EXPECTED_PATH[actionId]);
      expect(readResourceCalls[0]!.select).toEqual(fields);
      expect(readResourceCalls[0]!.accessToken).toBe(ACCESS_TOKEN);
    } else {
      expect(readResourceCalls).toHaveLength(0);
      expect(readCollectionCalls).toHaveLength(1);
      expect(readCollectionCalls[0]!.path).toBe(EXPECTED_PATH[actionId]);
      expect(readCollectionCalls[0]!.query['$select']).toBe(fields.join(','));
      expect(readCollectionCalls[0]!.accessToken).toBe(ACCESS_TOKEN);
    }
  });

  it('m365.user.list with search sets $search, $count, and consistencyLevelEventual', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.user.list', search: 'ada' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    const call = readCollectionCalls[0]!;
    expect(call.query['$search']).toBe('"displayName:ada" OR "userPrincipalName:ada"');
    expect(call.query['$count']).toBe('true');
    expect(call.consistencyLevelEventual).toBe(true);
  });

  it('m365.user.list without search omits $search/$count/consistencyLevelEventual', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction({ type: 'm365.user.list' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    const call = readCollectionCalls[0]!;
    expect(call.query['$search']).toBeUndefined();
    expect(call.query['$count']).toBeUndefined();
    expect(call.consistencyLevelEventual).toBeUndefined();
  });

  it('m365.user.list combines accountEnabled and department into a single $filter', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.user.list', accountEnabled: true, department: 'Sales' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    expect(readCollectionCalls[0]!.query['$filter']).toBe("accountEnabled eq true and department eq 'Sales'");
  });

  it('m365.group.list with search sets $search and consistencyLevelEventual but never $count', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.group.list', search: 'staff' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    const call = readCollectionCalls[0]!;
    expect(call.query['$search']).toBe('"displayName:staff"');
    expect(call.consistencyLevelEventual).toBe(true);
    expect(call.query['$count']).toBeUndefined();
  });

  it('m365.intune.device.list combines complianceState and operatingSystem into a single $filter', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.intune.device.list', complianceState: 'noncompliant', operatingSystem: 'Windows' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    expect(readCollectionCalls[0]!.query['$filter']).toBe("complianceState eq 'noncompliant' and operatingSystem eq 'Windows'");
  });

  it('m365.sites.list uses a bare `search` query param, not $search', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.sites.list', search: 'intranet' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    const call = readCollectionCalls[0]!;
    expect(call.query['search']).toBe('intranet');
    expect(call.query['$search']).toBeUndefined();
  });

  it('m365.signins.list builds createdDateTime ge from the injected clock and appends the UPN clause', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(
      { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 2 },
      { accessToken: ACCESS_TOKEN, graphClient: client, now: NOW },
    );

    expect(readCollectionCalls[0]!.query['$filter']).toBe(
      "createdDateTime ge 2026-07-17T22:00:00.000Z and userPrincipalName eq 'ada@contoso.com'",
    );
  });

  it('m365.signins.list defaults sinceHours to 24 and omits the UPN clause when absent', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction({ type: 'm365.signins.list' }, { accessToken: ACCESS_TOKEN, graphClient: client, now: NOW });

    expect(readCollectionCalls[0]!.query['$filter']).toBe('createdDateTime ge 2026-07-17T00:00:00.000Z');
  });

  it('projects only allowlisted fields off a resource, stripping unexpected keys', async () => {
    const { client } = createStubGraphClient({
      resource: {
        id: 'u1',
        userPrincipalName: 'ada@contoso.com',
        passwordProfile: { forceChangePasswordNextSignIn: true },
      },
    });

    const result = await executeGraphReadAction(
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    expect(result.success).toBe(true);
    expect(result.success && result.kind === 'resource' ? result.resource : undefined).toEqual({
      id: 'u1',
      userPrincipalName: 'ada@contoso.com',
    });
  });

  it('projects only allowlisted fields off every item in a collection', async () => {
    const { client } = createStubGraphClient({
      collection: {
        items: [{ id: 'g1', displayName: 'Staff', membershipRule: null, extraSecret: 'nope' }],
        truncated: false,
      },
    });

    const result = await executeGraphReadAction({ type: 'm365.group.list' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    expect(result.success).toBe(true);
    expect(result.success && result.kind === 'collection' ? result.items : undefined).toEqual([
      { id: 'g1', displayName: 'Staff', membershipRule: null },
    ]);
  });

  it('m365.org.get returns the first collection item as a resource', async () => {
    const { client } = createStubGraphClient({
      collection: { items: [{ id: 'org1', displayName: 'Contoso Ltd' }], truncated: false },
    });

    const result = await executeGraphReadAction({ type: 'm365.org.get' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    expect(result).toEqual({ success: true, kind: 'resource', resource: { id: 'org1', displayName: 'Contoso Ltd' } });
  });

  it('m365.org.get with an empty collection returns graph_not_found', async () => {
    const { client } = createStubGraphClient({ collection: { items: [], truncated: false } });

    const result = await executeGraphReadAction({ type: 'm365.org.get' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    expect(result).toEqual({ success: false, errorCode: 'graph_not_found' });
  });

  it('m365.org.get does not send $top', async () => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction({ type: 'm365.org.get' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    expect(readCollectionCalls[0]!.query['$top']).toBeUndefined();
  });

  it.each<[string, M365ReadAction, string | undefined, number, number]>([
    ['m365.signins.list', { type: 'm365.signins.list' }, '25', 2, 50],
    ['m365.sites.list', { type: 'm365.sites.list', search: 'intranet' }, '25', 1, 25],
    ['m365.org.skus.list', { type: 'm365.org.skus.list' }, undefined, 4, 60],
    ['m365.group.members.list', { type: 'm365.group.members.list', groupId: GROUP_ID }, '25', 4, 100],
  ])('%s applies the resolved pageSize/maxPages/maxItems caps', async (_label, action, expectedTop, expectedMaxPages, expectedMaxItems) => {
    const { client, readCollectionCalls } = createStubGraphClient();

    await executeGraphReadAction(action, { accessToken: ACCESS_TOKEN, graphClient: client, now: NOW });

    const call = readCollectionCalls[0]!;
    expect(call.query['$top']).toBe(expectedTop);
    expect(call.maxPages).toBe(expectedMaxPages);
    expect(call.maxItems).toBe(expectedMaxItems);
  });

  it('a GraphClientError with retryAfterSeconds maps to a failure result carrying it', async () => {
    const { client } = createStubGraphClient({ throwError: new GraphClientError('graph_throttled', 30) });

    const result = await executeGraphReadAction({ type: 'm365.user.list' }, { accessToken: ACCESS_TOKEN, graphClient: client });

    expect(result).toEqual({ success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30 });
  });

  it('a GraphClientError without retryAfterSeconds maps to a failure result without it', async () => {
    const { client } = createStubGraphClient({ throwError: new GraphClientError('graph_not_found') });

    const result = await executeGraphReadAction(
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { accessToken: ACCESS_TOKEN, graphClient: client },
    );

    expect(result).toEqual({ success: false, errorCode: 'graph_not_found' });
  });

  it.each<GraphClientError['code']>(['graph_provider_rejected', 'graph_request_invalid', 'organization_probe_failed'])(
    'maps executor-internal GraphClientError code %s to graph_response_invalid',
    async (code) => {
      const { client } = createStubGraphClient({ throwError: new GraphClientError(code) });

      const result = await executeGraphReadAction({ type: 'm365.org.skus.list' }, { accessToken: ACCESS_TOKEN, graphClient: client });

      expect(result).toEqual({ success: false, errorCode: 'graph_response_invalid' });
    },
  );

  it('does not rethrow GraphClientError out of executeGraphReadAction', async () => {
    const { client } = createStubGraphClient({ throwError: new GraphClientError('graph_permission_missing') });

    await expect(
      executeGraphReadAction({ type: 'm365.org.get' }, { accessToken: ACCESS_TOKEN, graphClient: client }),
    ).resolves.toEqual({ success: false, errorCode: 'graph_permission_missing' });
  });
});
