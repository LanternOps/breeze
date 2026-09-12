import { describe, expect, it } from 'vitest';
import { M365_READ_ACTION_FIELDS } from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet } from './graphClient';
import { executeGraphSyncAction } from './syncActions';
import { context, page, stubClient, TENANT_ID } from './syncActions.testHarness';
import { createSyncContinuationCodec } from '../syncContinuation';
import { createSigninLimiter } from '../signinLimiter';

const ADA = '22222222-2222-4222-8222-222222222222';
const NEXT = 'https://graph.microsoft.com/v1.0/users?$skiptoken=page2';

describe('m365.sync.signin_activity', () => {
  it('projects only the last SUCCESSFUL sign-in and asks for 500 per page', async () => {
    const { client, calls } = stubClient({
      '/users': page([
        { id: ADA, signInActivity: {
          lastSignInDateTime: '2026-09-07T09:00:00Z',            // failed attempts count here
          lastSuccessfulSignInDateTime: '2026-09-01T08:00:00Z',
        } },
        { id: '33333333-3333-4333-8333-333333333333' },          // never signed in
      ]),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items).toEqual([
      { id: ADA, lastSuccessfulSignInAt: '2026-09-01T08:00:00Z' },
      { id: '33333333-3333-4333-8333-333333333333', lastSuccessfulSignInAt: null },
    ]);
    expect(JSON.stringify(result.items)).not.toContain('2026-09-07');   // lastSignInDateTime never leaves
    expect(calls[0]!.query).toEqual({ '$select': 'id,signInActivity', '$top': '500' });
    expect(result.sources).toEqual({ signInActivity: 'ok' });
    expect(result.continuation).toBeUndefined();
  });

  it('returns a sealed continuation when pages remain, and resumes from it', async () => {
    const { client, calls } = stubClient({
      '/users': { items: [{ id: ADA }], stopReason: 'max_pages', pages: 5, nextLink: NEXT },
    });
    const ctx = context(client);
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, ctx);
    if (!('items' in result)) throw new Error('expected success');
    expect(result.truncated).toBe(false);              // paged, not truncated
    expect(result.continuation).toBeDefined();
    expect(result.continuation).not.toContain('skiptoken');

    const { client: second, calls: secondCalls } = stubClient({ '/users': page([{ id: ADA }]) });
    await executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: result.continuation! },
      { ...context(second), continuations: ctx.continuations },
    );
    expect(secondCalls[0]!.startUrl).toBe(NEXT);
    expect(calls).toHaveLength(1);
  });

  it('refuses a continuation minted for another tenant', async () => {
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const foreign = codec.seal({
      tenantId: '99999999-9999-4999-8999-999999999999',
      action: 'm365.sync.signin_activity',
      nextLink: NEXT,
    });
    const { client, calls } = stubClient({ '/users': page([]) });
    await expect(executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: foreign },
      { ...context(client), continuations: codec, tenantId: TENANT_ID },
    )).resolves.toEqual({ success: false, code: 'continuation_invalid' });
    expect(calls).toHaveLength(0);   // nothing is fetched on a bad continuation
  });

  it('reports unlicensed on 403 with zero items and no continuation', async () => {
    const { client } = stubClient({ '/users': new GraphClientError('graph_permission_missing') });
    const result = await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, context(client));
    expect(result).toMatchObject({
      success: true, items: [], truncated: false, sources: { signInActivity: 'unlicensed' },
    });
    if (!('items' in result)) throw new Error('expected success');
    expect(result.continuation).toBeUndefined();
  });

  it('returns immediately with the inbound continuation when the bucket is empty', async () => {
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const inbound = codec.seal({ tenantId: TENANT_ID, action: 'm365.sync.signin_activity', nextLink: NEXT });
    const limiter = createSigninLimiter({ requestsPerMinute: 1 });
    limiter.tryTake();                                    // drain it
    const { client, calls } = stubClient({
      '/users': { items: [], stopReason: 'paused', pages: 0 },
    });
    const result = await executeGraphSyncAction(
      { type: 'm365.sync.signin_activity', continuation: inbound },
      { ...context(client), continuations: codec, signinLimiter: limiter },
    );
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items).toEqual([]);
    expect(result.sources).toEqual({ signInActivity: 'throttled' });
    // The resume point survives — losing it would restart the walk.
    expect(codec.open({ tenantId: TENANT_ID, action: 'm365.sync.signin_activity', continuation: result.continuation! }))
      .toBe(NEXT);
    expect(calls).toHaveLength(1);
  });

  it('caps pages per call at M365_SIGNIN_PAGES_PER_CALL', async () => {
    const { client, calls } = stubClient({ '/users': page([]) });
    await executeGraphSyncAction({ type: 'm365.sync.signin_activity' }, {
      ...context(client),
      limits: { ...context(client).limits, signinPagesPerCall: 2 },
    });
    expect(calls[0]).toBeDefined();
  });
});

describe('m365.sync.intune_devices', () => {
  it('selects and projects exactly the allowlist and reports truncation', async () => {
    const device = {
      id: 'd1', deviceName: 'LAPTOP-01', operatingSystem: 'Windows', osVersion: '10.0.22631',
      complianceState: 'compliant', lastSyncDateTime: '2026-09-08T06:00:00Z',
      userPrincipalName: 'ada@contoso.com', managedDeviceOwnerType: 'company',
      enrolledDateTime: '2025-02-01T00:00:00Z', model: 'X1', manufacturer: 'Lenovo',
      serialNumber: 'PF0ABCDE', azureADDeviceId: 'aad-1', managementAgent: 'mdm', jailBroken: 'False',
      secretField: 'must not leak',
    };
    const { client, calls } = stubClient({
      '/deviceManagement/managedDevices': { items: [device], stopReason: 'max_items', pages: 60 },
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.intune_devices' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(Object.keys(result.items[0]!).sort())
      .toEqual([...M365_READ_ACTION_FIELDS['m365.sync.intune_devices']].sort());
    expect(JSON.stringify(result)).not.toContain('must not leak');
    expect(result).toMatchObject({ truncated: true, sources: { managedDevices: 'ok' } });
    expect(calls[0]!.query!['$top']).toBe('999');
  });

  it('fails the action when the primary source fails', async () => {
    const { client } = stubClient({
      '/deviceManagement/managedDevices': new GraphClientError('graph_throttled', 42),
    });
    await expect(executeGraphSyncAction({ type: 'm365.sync.intune_devices' }, context(client)))
      .resolves.toEqual({ success: false, code: 'graph_throttled', retryAfterSeconds: 42 });
  });
});

describe('m365.sync.ca_policies', () => {
  it('passes the policy condition objects through and uses a fixed 2 s backoff', async () => {
    const policy = {
      id: 'ca1', displayName: 'Require MFA for admins', state: 'enabled',
      createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-08-01T00:00:00Z',
      conditions: { users: { includeRoles: ['62e90394-69f5-4237-9190-012177145e10'] } },
      grantControls: { operator: 'OR', builtInControls: ['mfa'] },
      sessionControls: null,
      templateId: 'not-projected',
    };
    const seen: unknown[] = [];
    const client = {
      async probeTenant() { throw new Error('unused'); },
      async readResource() { throw new Error('unused'); },
      async readCollection() { throw new Error('unused'); },
      async readSyncCollection(input: { limits: { retry?: { fixedBackoffMs?: number } } }) {
        seen.push(input.limits.retry);
        return page([policy]) as GraphSyncPageSet;
      },
    };
    const result = await executeGraphSyncAction(
      { type: 'm365.sync.ca_policies' },
      context(client as never),
    );
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items[0]).toEqual({
      id: 'ca1', displayName: 'Require MFA for admins', state: 'enabled',
      createdDateTime: '2025-01-01T00:00:00Z', modifiedDateTime: '2026-08-01T00:00:00Z',
      conditions: policy.conditions, grantControls: policy.grantControls, sessionControls: null,
    });
    expect(seen[0]).toMatchObject({ fixedBackoffMs: 2_000 });
  });
});

describe('m365.sync.skus', () => {
  it('rebuilds prepaidUnits key by key and never sends $top', async () => {
    const { client, calls } = stubClient({
      '/subscribedSkus': page([{
        id: 'tenant_sku', skuId: 'sku-1', skuPartNumber: 'ENTERPRISEPACK',
        consumedUnits: 42, capabilityStatus: 'Enabled', appliesTo: 'User',
        prepaidUnits: { enabled: 50, suspended: 0, warning: 0, lockedOut: 1 },
        servicePlans: [{ servicePlanId: 'not-projected' }],
      }]),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.skus' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items[0]).toEqual({
      skuId: 'sku-1', skuPartNumber: 'ENTERPRISEPACK', consumedUnits: 42,
      prepaidUnits: { enabled: 50, suspended: 0, warning: 0 },
      capabilityStatus: 'Enabled', appliesTo: 'User',
    });
    expect(calls[0]!.query?.['$top']).toBeUndefined();   // /subscribedSkus rejects it
  });
});

describe('m365.sync.secure_score', () => {
  const SCORES = [{
    id: 'score-1', createdDateTime: '2026-09-08T00:00:00Z', currentScore: 210.5, maxScore: 400,
    activeUserCount: 120, licensedUserCount: 150,
    controlScores: [
      { controlName: 'MFARegistrationV2', score: 8, implementationStatus: 'partial', description: 'noise' },
      { controlName: 'UnknownControl', score: 0, implementationStatus: 'not started' },
    ],
    azureTenantId: 'not-projected',
  }];
  const PROFILES = [{ id: 'MFARegistrationV2', title: 'Ensure all users can complete MFA', maxScore: 10, controlCategory: 'Identity' }];

  it('joins control profiles for maxScore and title, and asks for 3 scores by default', async () => {
    const { client, calls } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': page(PROFILES),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.secure_score' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(calls[0]!.query!['$top']).toBe('3');
    expect(result.items[0]).toEqual({
      id: 'score-1', createdDateTime: '2026-09-08T00:00:00Z', currentScore: 210.5, maxScore: 400,
      activeUserCount: 120, licensedUserCount: 150,
      controlScores: [
        { controlName: 'MFARegistrationV2', title: 'Ensure all users can complete MFA', score: 8, maxScore: 10, implementationStatus: 'partial' },
        { controlName: 'UnknownControl', title: null, score: 0, maxScore: null, implementationStatus: 'not started' },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('noise');
    expect(result.sources).toEqual({ secureScores: 'ok', controlProfiles: 'ok' });
  });

  it('asks for 90 scores on a backfill run', async () => {
    const { client, calls } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': page(PROFILES),
    });
    await executeGraphSyncAction({ type: 'm365.sync.secure_score', backfill: true }, context(client));
    expect(calls[0]!.query!['$top']).toBe('90');
  });

  it('keeps the scores when the control profiles fail', async () => {
    const { client } = stubClient({
      '/security/secureScores': page(SCORES),
      '/security/secureScoreControlProfiles': new GraphClientError('graph_permission_missing'),
    });
    const result = await executeGraphSyncAction({ type: 'm365.sync.secure_score' }, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toEqual({ secureScores: 'ok', controlProfiles: 'permission_missing' });
    expect((result.items[0]!.controlScores as { maxScore: number | null }[])[0]!.maxScore).toBeNull();
  });
});
