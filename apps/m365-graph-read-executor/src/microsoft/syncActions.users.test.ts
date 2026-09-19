import { describe, expect, it } from 'vitest';
import { M365_READ_ACTION_FIELDS } from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet } from './graphClient';
import { executeGraphSyncAction } from './syncActions';
import { context, page, stubClient } from './syncActions.testHarness';

const ADA = '22222222-2222-4222-8222-222222222222';
const GRACE = '33333333-3333-4333-8333-333333333333';
const ADMINS_GROUP = '44444444-4444-4444-8444-444444444444';
const GLOBAL_ADMIN_TEMPLATE = '62e90394-69f5-4237-9190-012177145e10';
const E3_SKU = '55555555-5555-4555-8555-555555555555';

// Recorded Graph fixtures, trimmed to the fields the executor selects.
const USERS_PAGE = [
  {
    id: ADA, userPrincipalName: 'ada@contoso.com', displayName: 'Ada Lovelace',
    mail: 'ada@contoso.com', accountEnabled: true, jobTitle: 'Engineer',
    department: 'R&D', usageLocation: 'GB', onPremisesSyncEnabled: null,
    createdDateTime: '2024-01-02T03:04:05Z',
    assignedLicenses: [{ skuId: E3_SKU, disabledPlans: [] }],
  },
  {
    id: GRACE, userPrincipalName: 'grace@contoso.com', displayName: 'Grace Hopper',
    mail: null, accountEnabled: false, jobTitle: null, department: null,
    usageLocation: null, onPremisesSyncEnabled: true,
    createdDateTime: '2023-06-01T00:00:00Z', assignedLicenses: [],
  },
];

const REGISTRATION_PAGE = [
  { id: ADA, isMfaRegistered: true, isMfaCapable: true, defaultMfaMethod: 'microsoftAuthenticatorPush' },
  // Grace is deliberately absent: the report lags and excludes some accounts.
  { id: '99999999-9999-4999-8999-999999999999', isMfaRegistered: true, isMfaCapable: true, defaultMfaMethod: 'sms' },
];

const ROLE_ASSIGNMENTS_PAGE = [
  { id: 'ra-1', principalId: ADA, roleDefinition: { id: 'rd-1', templateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' } },
  { id: 'ra-2', principalId: ADMINS_GROUP, roleDefinition: { id: 'rd-2', templateId: '729827e3-9c14-49f7-bb1b-9608f156bbb8', displayName: 'Helpdesk Administrator' } },
];

const GROUP_MEMBERS_PAGE = [{ id: GRACE }];

const HAPPY = {
  '/users': page(USERS_PAGE),
  '/reports/authenticationMethods/userRegistrationDetails': page(REGISTRATION_PAGE),
  '/roleManagement/directory/roleAssignments': page(ROLE_ASSIGNMENTS_PAGE),
  [`/groups/${ADMINS_GROUP}/members`]: page(GROUP_MEMBERS_PAGE),
};

describe('executeGraphSyncAction — m365.sync.users', () => {
  it('merges all three sources into one projected item per user', async () => {
    const { client, calls } = stubClient(HAPPY);
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));

    expect(result).toMatchObject({ success: true, kind: 'sync', truncated: false });
    if (!('items' in result)) throw new Error('expected success');
    expect(result.fetchedAt).toBe('2026-09-08T12:00:00.000Z');
    expect(result.sources).toEqual({ users: 'ok', mfaRegistration: 'ok', roleAssignments: 'ok' });
    expect(result.items).toEqual([
      {
        id: ADA, userPrincipalName: 'ada@contoso.com', displayName: 'Ada Lovelace',
        mail: 'ada@contoso.com', accountEnabled: true, jobTitle: 'Engineer',
        department: 'R&D', usageLocation: 'GB', onPremisesSyncEnabled: null,
        createdDateTime: '2024-01-02T03:04:05Z',
        assignedLicenses: [E3_SKU],
        mfaRegistered: true, mfaCapable: true, defaultMfaMethod: 'microsoftAuthenticatorPush',
        adminRoles: [{ roleTemplateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' }],
      },
      {
        id: GRACE, userPrincipalName: 'grace@contoso.com', displayName: 'Grace Hopper',
        mail: null, accountEnabled: false, jobTitle: null, department: null,
        usageLocation: null, onPremisesSyncEnabled: true,
        createdDateTime: '2023-06-01T00:00:00Z',
        assignedLicenses: [],
        // Absent from the registration report ⇒ unknown, NEVER false.
        mfaRegistered: null, mfaCapable: null, defaultMfaMethod: null,
        adminRoles: [{
          roleTemplateId: '729827e3-9c14-49f7-bb1b-9608f156bbb8',
          displayName: 'Helpdesk Administrator',
          viaGroupId: ADMINS_GROUP,
        }],
      },
    ]);
    // The user in the report but not in /users is dropped entirely.
    expect(JSON.stringify(result.items)).not.toContain('99999999');
    // Every emitted key is on the allowlist.
    for (const item of result.items) {
      for (const key of Object.keys(item)) {
        expect(M365_READ_ACTION_FIELDS['m365.sync.users']).toContain(key);
      }
    }
    expect(calls.map((c) => c.path)).toEqual([
      '/users',
      '/reports/authenticationMethods/userRegistrationDetails',
      '/roleManagement/directory/roleAssignments',
      `/groups/${ADMINS_GROUP}/members`,
    ]);
    expect(calls[0]!.query).toMatchObject({ '$top': '999' });
    expect(calls[0]!.query!['$select']).toContain('assignedLicenses');
    // signInActivity is NOT selected here — it is its own throttled domain.
    expect(calls[0]!.query!['$select']).not.toContain('signInActivity');
  });

  it('fails the whole action when the PRIMARY source fails', async () => {
    const { client } = stubClient({ ...HAPPY, '/users': new GraphClientError('graph_permission_missing') });
    await expect(executeGraphSyncAction({ type: 'm365.sync.users' }, context(client)))
      .resolves.toEqual({ success: false, code: 'graph_permission_missing' });
  });

  it('degrades a failed registration report to a source state and null enrichment', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/reports/authenticationMethods/userRegistrationDetails': new GraphClientError('graph_permission_missing'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ users: 'ok', mfaRegistration: 'permission_missing' });
    expect(result.items.every((item) => item.mfaRegistered === null)).toBe(true);
    expect(result.items[0]!.adminRoles).not.toBeNull();   // roles are unaffected
  });

  it('degrades failed role assignments to adminRoles: null, not an empty list', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/roleManagement/directory/roleAssignments': new GraphClientError('graph_throttled', 30),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'throttled' });
    // null = unknown. [] would claim "definitely not an admin".
    expect(result.items.every((item) => item.adminRoles === null)).toBe(true);
  });

  it('discards a TRUNCATED secondary source rather than inventing absences', async () => {
    const { client } = stubClient({
      ...HAPPY,
      '/reports/authenticationMethods/userRegistrationDetails': {
        items: REGISTRATION_PAGE, stopReason: 'max_items', pages: 1,
      },
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ mfaRegistration: 'error' });
    expect(result.items[0]!.mfaRegistered).toBeNull();   // Ada's row is dropped with the rest
    expect(result.truncated).toBe(false);                // the PRIMARY was complete
  });

  it('reports truncation when the primary enumeration is incomplete', async () => {
    const { client } = stubClient({ ...HAPPY, '/users': { items: USERS_PAGE, stopReason: 'max_items', pages: 60 } });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    expect(result).toMatchObject({ success: true, truncated: true });
  });

  it('skips a role principal that is not a group and keeps the rest', async () => {
    const { client } = stubClient({
      ...HAPPY,
      [`/groups/${ADMINS_GROUP}/members`]: new GraphClientError('graph_not_found'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'ok' });
    expect(result.items[0]!.adminRoles).toHaveLength(1);   // Ada keeps her direct assignment
    expect(result.items[1]!.adminRoles).toEqual([]);       // Grace gains nothing
  });

  it('degrades ALL adminRoles to null when a group\'s own member page truncates — never a partial []', async () => {
    const { client } = stubClient({
      ...HAPPY,
      // The group has more members than fit in the fetch's page cap: we get
      // SOME members back, but cannot tell whether Grace (or anyone else) is
      // among the ones we did not see.
      [`/groups/${ADMINS_GROUP}/members`]: { items: GROUP_MEMBERS_PAGE, stopReason: 'max_items', pages: 1 },
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'error' });
    // Ada's DIRECT assignment is unaffected by an unrelated group's truncation.
    expect(result.items[0]!.adminRoles).toBeNull();
    // Grace would previously read [] here — a false "definitely not an admin"
    // — because the partial member page happened not to include her ID.
    expect(result.items[1]!.adminRoles).toBeNull();
  });

  it('degrades ALL adminRoles to null when a group\'s own member fetch errors (not 404)', async () => {
    const { client } = stubClient({
      ...HAPPY,
      [`/groups/${ADMINS_GROUP}/members`]: new GraphClientError('graph_throttled', 30),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toMatchObject({ roleAssignments: 'error' });
    expect(result.items[0]!.adminRoles).toBeNull();
    expect(result.items[1]!.adminRoles).toBeNull();
  });

  it('caps group expansion at 50 lookups and says so through the source state', async () => {
    const groups = Array.from({ length: 60 }, (_unused, index) => `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`);
    const responses: Record<string, GraphSyncPageSet | GraphClientError> = {
      ...HAPPY,
      '/roleManagement/directory/roleAssignments': page(groups.map((groupId, index) => ({
        id: `ra-${index}`, principalId: groupId,
        roleDefinition: { id: 'rd', templateId: GLOBAL_ADMIN_TEMPLATE, displayName: 'Global Administrator' },
      }))),
    };
    for (const groupId of groups) responses[`/groups/${groupId}/members`] = page([{ id: ADA }]);
    const { client, calls } = stubClient(responses);
    const result = await executeGraphSyncAction({ type: 'm365.sync.users' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(calls.filter((call) => call.path.startsWith('/groups/'))).toHaveLength(50);
    expect(result.sources).toMatchObject({ roleAssignments: 'error' }); // incomplete expansion is not 'ok'
  });
});
