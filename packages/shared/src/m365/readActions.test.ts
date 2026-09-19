import { describe, expect, it } from 'vitest';
import {
  M365_READ_ACTION_IDS,
  M365_READ_ACTION_FIELDS,
  M365_INTERACTIVE_READ_ACTION_IDS,
  type M365InteractiveReadActionId,
  M365_SYNC_ACTION_IDS,
  M365_SYNC_CONTINUATION_MAX_CHARS,
  isM365SyncActionId,
  isM365SyncAction,
  m365ReadActionSchema,
  m365SyncActionSchema,
  m365SyncActionResponseSchema,
  m365SyncActionResultSchema,
  m365SyncFailureCodeSchema,
  readActionRequestSchema,
  readActionResultSchema,
  readActionFailureCodeSchema,
  syncActionRequestSchema,
} from './readActions';

const GUID = '11111111-2222-3333-4444-555555555555';

describe('m365 read action contracts', () => {
  it('defines exactly the 12 interactive catalog actions with non-empty field allowlists', () => {
    expect(M365_INTERACTIVE_READ_ACTION_IDS).toEqual([
      'm365.user.list', 'm365.user.get', 'm365.signins.list',
      'm365.intune.device.list', 'm365.intune.device.get',
      'm365.group.list', 'm365.group.get', 'm365.group.members.list',
      'm365.org.get', 'm365.org.skus.list',
      'm365.sites.list', 'm365.site.get',
    ]);
    for (const id of M365_READ_ACTION_IDS) {
      expect(M365_READ_ACTION_FIELDS[id].length).toBeGreaterThan(0);
      expect(new Set(M365_READ_ACTION_FIELDS[id]).size).toBe(M365_READ_ACTION_FIELDS[id].length);
    }
  });

  it('accepts every action variant at its bounds', () => {
    const variants = [
      { type: 'm365.user.list', search: 'ada', accountEnabled: true, pageSize: 50 },
      { type: 'm365.user.get', userIdOrUpn: 'ada@contoso.com' },
      { type: 'm365.signins.list', userPrincipalName: 'ada@contoso.com', sinceHours: 168, pageSize: 50 },
      { type: 'm365.intune.device.list', complianceState: 'noncompliant', pageSize: 50 },
      { type: 'm365.intune.device.get', deviceId: GUID },
      { type: 'm365.group.list', search: 'staff', pageSize: 50 },
      { type: 'm365.group.get', groupId: GUID },
      { type: 'm365.group.members.list', groupId: GUID, pageSize: 100 },
      { type: 'm365.org.get' },
      { type: 'm365.org.skus.list' },
      { type: 'm365.sites.list', search: 'intranet' },
      { type: 'm365.site.get', siteId: 'contoso.sharepoint.com,111,222' },
    ];
    for (const action of variants) {
      expect(m365ReadActionSchema.safeParse(action).success, JSON.stringify(action)).toBe(true);
      expect(readActionRequestSchema.safeParse({
        correlationId: GUID, tenantId: GUID, action,
      }).success).toBe(true);
    }
  });

  it('rejects out-of-bound and unknown inputs', () => {
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', pageSize: 51 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.signins.list', sinceHours: 169 }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.sites.list' }).success).toBe(false); // search required
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.get', userIdOrUpn: "a'; drop--@x.com" }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.mail.send' }).success).toBe(false);
    expect(m365ReadActionSchema.safeParse({ type: 'm365.user.list', extra: 1 }).success).toBe(false);
  });

  it('round-trips collection, resource, and failure results', () => {
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'collection', items: [{ id: GUID }], truncated: false,
    }).success).toBe(true);
    expect(readActionResultSchema.safeParse({
      success: true, kind: 'resource', resource: { id: GUID },
    }).success).toBe(true);
    // The SHIPPED interactive failure shape keeps its `errorCode` key. This wave
    // must not rename it — readActionResultSchema is consumed by the executor's
    // interactive path and by readActionService. The SYNC failure shape uses
    // `code` instead (see m365SyncActionFailureSchema); the asymmetry is
    // deliberate and asserted both ways below.
    expect(readActionResultSchema.safeParse({
      success: false, errorCode: 'graph_throttled', retryAfterSeconds: 30,
    }).success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('grant_missing').success).toBe(false);
  });
});

describe('m365 sync action contracts', () => {
  it('appends exactly the seven sync ids to the read catalog', () => {
    expect(M365_SYNC_ACTION_IDS).toEqual([
      'm365.sync.users', 'm365.sync.signin_activity', 'm365.sync.intune_devices',
      'm365.sync.ca_policies', 'm365.sync.skus', 'm365.sync.secure_score',
      'm365.sync.signin_events',
    ]);
    expect(M365_READ_ACTION_IDS).toEqual([
      ...M365_INTERACTIVE_READ_ACTION_IDS, ...M365_SYNC_ACTION_IDS,
    ]);
    for (const id of M365_SYNC_ACTION_IDS) expect(isM365SyncActionId(id)).toBe(true);
    for (const id of M365_INTERACTIVE_READ_ACTION_IDS) expect(isM365SyncActionId(id)).toBe(false);
  });

  it('projects exactly the contracted keys per sync action', () => {
    expect(M365_READ_ACTION_FIELDS['m365.sync.users']).toEqual([
      'id', 'userPrincipalName', 'displayName', 'mail', 'accountEnabled', 'jobTitle',
      'department', 'usageLocation', 'onPremisesSyncEnabled', 'createdDateTime',
      'assignedLicenses', 'mfaRegistered', 'mfaCapable', 'defaultMfaMethod', 'adminRoles',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).toEqual(['id', 'lastSuccessfulSignInAt']);
    expect(M365_READ_ACTION_FIELDS['m365.sync.intune_devices']).toEqual([
      'id', 'deviceName', 'operatingSystem', 'osVersion', 'complianceState', 'lastSyncDateTime',
      'userPrincipalName', 'managedDeviceOwnerType', 'enrolledDateTime', 'model', 'manufacturer',
      'serialNumber', 'azureADDeviceId', 'managementAgent', 'jailBroken',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.ca_policies']).toEqual([
      'id', 'displayName', 'state', 'createdDateTime', 'modifiedDateTime',
      'conditions', 'grantControls', 'sessionControls',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.skus']).toEqual([
      'skuId', 'skuPartNumber', 'consumedUnits', 'prepaidUnits', 'capabilityStatus', 'appliesTo',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.secure_score']).toEqual([
      'id', 'createdDateTime', 'currentScore', 'maxScore', 'activeUserCount',
      'licensedUserCount', 'controlScores',
    ]);
    // #5784 W05. No raw payload leaves the executor: the persister flattens
    // `location` and `status`, and nothing else is projected. deviceDetail and
    // appliedConditionalAccessPolicies are deliberately absent.
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_events']).toEqual([
      'id', 'createdDateTime', 'userId', 'userPrincipalName', 'appId', 'appDisplayName',
      'clientAppUsed', 'ipAddress', 'location', 'conditionalAccessStatus', 'status',
      'riskLevelAggregated', 'riskState', 'isInteractive',
    ]);
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_events']).not.toContain('deviceDetail');
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_events'])
      .not.toContain('appliedConditionalAccessPolicies');
    // lastSignInDateTime counts FAILED interactive attempts (spec §4.1) and must
    // never reach the API.
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).not.toContain('lastSignInDateTime');
    expect(M365_READ_ACTION_FIELDS['m365.sync.signin_activity']).not.toContain('signInActivity');
  });

  it('accepts the seven sync branches and their only optional inputs', () => {
    for (const type of M365_SYNC_ACTION_IDS) {
      expect(m365SyncActionSchema.safeParse({ type }).success, type).toBe(true);
      expect(m365ReadActionSchema.safeParse({ type }).success, type).toBe(true);
    }
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_activity', continuation: 'x'.repeat(M365_SYNC_CONTINUATION_MAX_CHARS),
    }).success).toBe(true);
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_activity', continuation: 'x'.repeat(M365_SYNC_CONTINUATION_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.secure_score', backfill: true }).success).toBe(true);
    // #5784 W05. The window is a pair of ISO instants; a non-datetime is rejected
    // rather than silently widened into a full-tenant scan.
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_events',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-08T00:00:00.000Z',
    }).success).toBe(true);
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_events', since: 'last week',
    }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({
      type: 'm365.sync.signin_events', continuation: 'x'.repeat(M365_SYNC_CONTINUATION_MAX_CHARS + 1),
    }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.users', since: '2026-09-01T00:00:00.000Z' }).success)
      .toBe(false);
    // Options belong to exactly one branch.
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.users', backfill: true }).success).toBe(false);
    expect(m365SyncActionSchema.safeParse({ type: 'm365.sync.skus', continuation: 'x' }).success).toBe(false);
    // The sync schema refuses interactive ids…
    expect(m365SyncActionSchema.safeParse({ type: 'm365.user.list' }).success).toBe(false);
    // …and syncActionRequestSchema refuses them too.
    expect(syncActionRequestSchema.safeParse({
      correlationId: GUID, tenantId: GUID, action: { type: 'm365.user.list' },
    }).success).toBe(false);
    expect(syncActionRequestSchema.safeParse({
      correlationId: GUID, tenantId: GUID, action: { type: 'm365.sync.users' },
    }).success).toBe(true);
  });

  it('keeps all twelve interactive branches, each still .strict()', () => {
    // The interactive branches move wholesale from m365ReadActionSchema into
    // INTERACTIVE_BRANCHES. A branch dropped in that cut, or a `.strict()` lost
    // to a retype, is invisible to every other assertion here: the id arrays are
    // edited by hand and would still read correctly. Assert the union's actual
    // shape instead.
    const branchIds = (m365ReadActionSchema.options as readonly {
      shape: { type: { value: string } };
    }[]).map((branch) => branch.shape.type.value);

    expect(branchIds).toHaveLength(19);
    expect(branchIds.filter((id) => !isM365SyncActionId(id)))
      .toEqual([...M365_INTERACTIVE_READ_ACTION_IDS]);   // all twelve, in order
    expect(branchIds.filter((id) => isM365SyncActionId(id)))
      .toEqual([...M365_SYNC_ACTION_IDS]);

    // .strict() is the only thing stopping an unknown key riding into the
    // executor. Prove it per branch: a minimal VALID payload parses, and the
    // same payload plus one extra key must not.
    const MINIMAL: Record<M365InteractiveReadActionId, Record<string, unknown>> = {
      'm365.user.list': {},
      'm365.user.get': { userIdOrUpn: 'ada@contoso.com' },
      'm365.signins.list': {},
      'm365.intune.device.list': {},
      'm365.intune.device.get': { deviceId: GUID },
      'm365.group.list': {},
      'm365.group.get': { groupId: GUID },
      'm365.group.members.list': { groupId: GUID },
      'm365.org.get': {},
      'm365.org.skus.list': {},
      'm365.sites.list': { search: 'intranet' },
      'm365.site.get': { siteId: 'contoso.sharepoint.com,111,222' },
    };
    for (const id of M365_INTERACTIVE_READ_ACTION_IDS) {
      expect(m365ReadActionSchema.safeParse({ type: id, ...MINIMAL[id] }).success, id).toBe(true);
      expect(
        m365ReadActionSchema.safeParse({ type: id, ...MINIMAL[id], breezeUnknownKey: 1 }).success,
        `${id} accepted an unknown key — its .strict() was dropped`,
      ).toBe(false);
    }
    // Same guarantee on the sync half, which is authored fresh in this task.
    for (const id of M365_SYNC_ACTION_IDS) {
      expect(m365ReadActionSchema.safeParse({ type: id, breezeUnknownKey: 1 }).success, id).toBe(false);
    }
  });

  it('narrows a parsed read action to the sync half', () => {
    const sync = m365ReadActionSchema.parse({ type: 'm365.sync.ca_policies' });
    const interactive = m365ReadActionSchema.parse({ type: 'm365.org.get' });
    expect(isM365SyncAction(sync)).toBe(true);
    expect(isM365SyncAction(interactive)).toBe(false);
  });

  it('round-trips the sync result, its continuation, and the failure union', () => {
    const result = {
      success: true as const,
      kind: 'sync' as const,
      items: [{ id: GUID, mfaRegistered: null }],
      truncated: false,
      fetchedAt: '2026-09-08T00:00:00.000Z',
      sources: { users: 'ok', mfaRegistration: 'permission_missing', roleAssignments: 'error' },
    };
    expect(m365SyncActionResultSchema.safeParse(result).success).toBe(true);
    expect(m365SyncActionResultSchema.safeParse({ ...result, continuation: 'opaque' }).success).toBe(true);
    expect(m365SyncActionResultSchema.safeParse({ ...result, sources: { users: 'nope' } }).success).toBe(false);
    expect(m365SyncActionResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
    expect(m365SyncActionResultSchema.safeParse({ ...result, fetchedAt: 'yesterday' }).success).toBe(false);

    expect(m365SyncActionResponseSchema.safeParse(result).success).toBe(true);
    expect(m365SyncActionResponseSchema.safeParse({
      success: false, code: 'continuation_invalid',
    }).success).toBe(true);
    expect(m365SyncActionResponseSchema.safeParse({
      success: false, code: 'graph_throttled', retryAfterSeconds: 45,
    }).success).toBe(true);
    // The sync failure key is `code`, NEVER `errorCode`. The shipped interactive
    // key must not leak in: m365SyncActionFailureSchema is .strict() and requires
    // `code`, so an errorCode-shaped body is rejected outright.
    expect(m365SyncActionResponseSchema.safeParse({
      success: false, errorCode: 'continuation_invalid',
    }).success).toBe(false);
    // continuation_invalid is sync-only; the read failure enum stays unchanged.
    expect(m365SyncFailureCodeSchema.safeParse('continuation_invalid').success).toBe(true);
    expect(readActionFailureCodeSchema.safeParse('continuation_invalid').success).toBe(false);
    expect(m365SyncFailureCodeSchema.safeParse('sync_capacity').success).toBe(false);
    // The sync enum is exactly the read enum plus one code — asserted by
    // derivation so a future read-enum addition cannot silently skip sync.
    expect(m365SyncFailureCodeSchema.options).toEqual([
      ...readActionFailureCodeSchema.options, 'continuation_invalid',
    ]);
  });
});
