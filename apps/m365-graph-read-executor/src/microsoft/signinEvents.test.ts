import { describe, expect, it } from 'vitest';
import { M365_READ_ACTION_FIELDS } from '@breeze/shared/m365';
import { GraphClientError, type GraphSyncPageSet } from './graphClient';
import { executeGraphSyncAction } from './syncActions';
import { context, page, stubClient, TENANT_ID } from './syncActions.testHarness';
import { createSyncContinuationCodec } from '../syncContinuation';
import { createSigninEventsLimiter } from '../signinEventsLimiter';

const SINCE = '2026-09-01T00:00:00.000Z';
const UNTIL = '2026-09-08T00:00:00.000Z';
const NEXT = 'https://graph.microsoft.com/v1.0/auditLogs/signIns?$skiptoken=page2';
const PATH = '/auditLogs/signIns';

function ev(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    createdDateTime: '2026-09-02T09:00:00Z',
    userId: '22222222-2222-4222-8222-222222222222',
    userPrincipalName: 'ada@contoso.com',
    appId: 'app-1',
    appDisplayName: 'Outlook',
    clientAppUsed: 'Browser',
    ipAddress: '203.0.113.7',
    location: { city: 'Austin', countryOrRegion: 'US' },
    conditionalAccessStatus: 'success',
    status: { errorCode: 0 },
    riskLevelAggregated: 'none',
    riskState: 'none',
    isInteractive: true,
    ...over,
  };
}

const action = { type: 'm365.sync.signin_events', since: SINCE, until: UNTIL } as const;

describe('m365.sync.signin_events', () => {
  it('filters on the half-open window only', async () => {
    const { client, calls } = stubClient({ [PATH]: page([ev('1')]) });
    const result = await executeGraphSyncAction(action, context(client));
    if (!('items' in result)) throw new Error('expected success');
    const query = calls[0]!.query!;
    expect(query.$filter).toContain(`createdDateTime ge ${SINCE}`);
    expect(query.$filter).toContain(`createdDateTime lt ${UNTIL}`);
    // #9393: `signInEventTypes` is a /beta-only property; v1.0 answers 400 to
    // any $filter that names it. v1.0 /auditLogs/signIns is already the
    // interactive collection, so the window is the whole filter.
    expect(query.$filter).not.toContain('signInEventTypes');
    expect(query.$filter).toBe(`createdDateTime ge ${SINCE} and createdDateTime lt ${UNTIL}`);
    expect(result.sources).toEqual({ signinEvents: 'ok' });
  });

  it('asks for the shape that returns a first page promptly: no $orderby, a narrow $select, small pages (#9394)', async () => {
    const { client, calls } = stubClient({ [PATH]: page([ev('1')]) });
    await executeGraphSyncAction(action, context(client));
    const query = calls[0]!.query!;
    // With an explicit ascending sort the first page never came back inside
    // 30 s on a reporting tenant; the unsorted, narrowly selected form did.
    expect(query).not.toHaveProperty('$orderby');
    expect(query.$select!.split(',').sort()).toEqual([...M365_READ_ACTION_FIELDS['m365.sync.signin_events']].sort());
    expect(query.$top).toBe('100');
    expect(Object.keys(query).sort()).toEqual(['$filter', '$select', '$top']);
  });

  it('takes its page size from M365_SYNC_SIGNIN_EVENTS_PAGE_SIZE (#9394)', async () => {
    const { client, calls } = stubClient({ [PATH]: page([ev('1')]) });
    const ctx = context(client);
    await executeGraphSyncAction(action, { ...ctx, limits: { ...ctx.limits, signinEventsPageSize: 40 } });
    expect(calls[0]!.query!.$top).toBe('40');
  });

  it('keeps the pages it read when a later page times out, and resumes from that page (#9394)', async () => {
    const { client, calls } = stubClient({
      [PATH]: { items: [ev('1'), ev('2')], stopReason: 'interrupted', pages: 1, nextLink: NEXT },
    });
    const ctx = context(client);
    const result = await executeGraphSyncAction(action, ctx);
    if (!('items' in result)) throw new Error('expected success');
    expect(calls[0]!.keepPagesOnTransientFailure).toBe(true);
    expect(result.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(result.truncated).toBe(false);
    expect(ctx.continuations.open({
      tenantId: TENANT_ID, action: 'm365.sync.signin_events', continuation: result.continuation!,
    })).toBe(NEXT);
  });

  it('pages until the window is exhausted and returns no continuation', async () => {
    const { client } = stubClient({ [PATH]: page([ev('1'), ev('2')]) });
    const result = await executeGraphSyncAction(action, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(result.continuation).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('returns a continuation and truncated=true when the item cap is hit', async () => {
    const pageSet: GraphSyncPageSet = {
      items: [ev('1')], stopReason: 'max_items', pages: 1, nextLink: NEXT,
    };
    const { client } = stubClient({ [PATH]: pageSet });
    const result = await executeGraphSyncAction(action, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.truncated).toBe(true);
    expect(result.continuation).toBeTruthy();
    expect(result.continuation).not.toContain('skiptoken');
  });

  it('stops paging without blocking when the token bucket is empty', async () => {
    // tryTake NEVER blocks: an empty bucket hands back a continuation, which is
    // strictly better than holding an executor slot asleep (signinLimiter.ts).
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const inbound = codec.seal({ tenantId: TENANT_ID, action: 'm365.sync.signin_events', nextLink: NEXT });
    const limiter = createSigninEventsLimiter({ requestsPerMinute: 1 });
    limiter.tryTake();                                   // drain it
    const { client } = stubClient({ [PATH]: { items: [], stopReason: 'paused', pages: 0 } });
    const result = await executeGraphSyncAction(
      { ...action, continuation: inbound },
      { ...context(client), continuations: codec, signinEventsLimiter: limiter },
    );
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources).toEqual({ signinEvents: 'throttled' });
    expect(codec.open({ tenantId: TENANT_ID, action: 'm365.sync.signin_events', continuation: result.continuation! }))
      .toBe(NEXT);
  });

  it('projects only the allowlisted fields — no raw payload leaves the executor', async () => {
    const { client } = stubClient({
      [PATH]: page([{
        ...ev('1'),
        deviceDetail: { browser: 'Edge', deviceId: 'd1' },
        appliedConditionalAccessPolicies: [{ id: 'p1' }],
        authenticationDetails: [{ authenticationMethod: 'Password' }],
      }]),
    });
    const result = await executeGraphSyncAction(action, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(Object.keys(result.items[0]!).sort())
      .toEqual([...M365_READ_ACTION_FIELDS['m365.sync.signin_events']].sort());
    const serialized = JSON.stringify(result.items);
    expect(serialized).not.toContain('deviceDetail');
    expect(serialized).not.toContain('appliedConditionalAccessPolicies');
    expect(serialized).not.toContain('authenticationDetails');
  });

  it('reports an unlicensed tenant as a complete, zero-item success', async () => {
    // Graph answers 403 for /auditLogs/signIns on a tenant without Entra ID P1.
    const { client } = stubClient({ [PATH]: new GraphClientError('graph_license_required') });
    const result = await executeGraphSyncAction(action, context(client));
    if (!('items' in result)) throw new Error('expected success');
    expect(result.sources.signinEvents).toBe('unlicensed');
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.continuation).toBeUndefined();
  });

  it('does NOT launder a missing permission into an unlicensed success', async () => {
    // graph_permission_missing is the catch-all for every OTHER 403 — a revoked
    // AuditLog.Read.All grant, a Conditional Access block on the app. Reporting
    // it as an unlicensed success would leave the domain "succeeding" with zero
    // rows forever and make run.ts's needs_consent/Retest branch dead code for
    // this domain, so an evidence report would quietly cover nothing.
    const { client } = stubClient({ [PATH]: new GraphClientError('graph_permission_missing') });
    const result = await executeGraphSyncAction(action, context(client));
    expect(result).toEqual({ success: false, code: 'graph_permission_missing' });
  });

  it('reports a Graph-rejected query as graph_provider_rejected, not graph_response_invalid', async () => {
    // #9393: a 400 from Graph (a bad $filter, say) is a rejected REQUEST. Folding
    // it into graph_response_invalid made a bad filter read like malformed JSON.
    const { client } = stubClient({ [PATH]: new GraphClientError('graph_provider_rejected') });
    const result = await executeGraphSyncAction(action, context(client));
    expect(result).toEqual({ success: false, code: 'graph_provider_rejected' });
  });

  it('refuses a continuation minted for another action', async () => {
    const codec = createSyncContinuationCodec({ key: Buffer.alloc(32, 1) });
    const foreign = codec.seal({
      tenantId: TENANT_ID, action: 'm365.sync.signin_activity', nextLink: NEXT,
    });
    const { client, calls } = stubClient({ [PATH]: page([]) });
    await expect(executeGraphSyncAction(
      { ...action, continuation: foreign },
      { ...context(client), continuations: codec },
    )).resolves.toEqual({ success: false, code: 'continuation_invalid' });
    expect(calls).toHaveLength(0);
  });

  it('defaults an absent window to a bounded one-day pull rather than the whole tenant (#9394)', async () => {
    const { client, calls } = stubClient({ [PATH]: page([]) });
    await executeGraphSyncAction({ type: 'm365.sync.signin_events' }, context(client));
    const filter = calls[0]!.query!.$filter!;
    // context()'s clock is 2026-09-08T12:00:00Z.
    expect(filter).toContain('createdDateTime lt 2026-09-08T12:00:00.000Z');
    expect(filter).toContain('createdDateTime ge 2026-09-07T12:00:00.000Z');
  });

  it('caps items at M365_SYNC_MAX_ITEMS_SIGNIN_EVENTS', async () => {
    const { client } = stubClient({ [PATH]: page([ev('1')]) });
    const ctx = context(client);
    const result = await executeGraphSyncAction(action, {
      ...ctx,
      limits: { ...ctx.limits, maxItemsSigninEvents: 7 },
    });
    expect('items' in result).toBe(true);
  });
});
