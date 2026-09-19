import { GraphClientError, type GraphSyncPageSet, type MicrosoftGraphClient } from './graphClient';
import type { GraphSyncActionContext } from './syncActions';
import type { OpaqueAccessToken } from './tokenClient';
import { createSyncContinuationCodec } from '../syncContinuation';
import { createSigninLimiter } from '../signinLimiter';
import { createSigninEventsLimiter } from '../signinEventsLimiter';

/**
 * Shared fixtures for the syncActions test suites, extracted so the users and
 * domains suites cannot drift on what a stub Graph client, a complete page,
 * or a base action context looks like (plan task 9, step 1).
 */

export const ACCESS_TOKEN = 'opaque-test-access-token' as OpaqueAccessToken;
export const TENANT_ID = '11111111-1111-4111-8111-111111111111';

export type Call = { path: string; query?: Record<string, string>; startUrl?: string };

export function stubClient(responses: Record<string, GraphSyncPageSet | GraphClientError>): {
  client: MicrosoftGraphClient; calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    async probeTenant() { throw new Error('unused'); },
    async readResource() { throw new Error('unused'); },
    async readCollection() { throw new Error('sync actions use readSyncCollection'); },
    async readSyncCollection(input: Parameters<MicrosoftGraphClient['readSyncCollection']>[0]) {
      calls.push({ path: input.path, query: input.query, startUrl: input.startUrl });
      const response = responses[input.path];
      if (response === undefined) throw new Error(`no fixture for ${input.path}`);
      if (response instanceof GraphClientError) throw response;
      if (input.beforePage !== undefined) input.beforePage();
      return response;
    },
  } as unknown as MicrosoftGraphClient;
  return { client, calls };
}

export const page = (items: Record<string, unknown>[]): GraphSyncPageSet => ({ items, stopReason: 'complete', pages: 1 });

export function context(client: MicrosoftGraphClient): GraphSyncActionContext {
  return {
    accessToken: ACCESS_TOKEN,
    graphClient: client,
    tenantId: TENANT_ID,
    limits: {
      syncMaxInFlight: 4, maxInFlight: 32, signinActivityRpm: 4, signinPagesPerCall: 5,
      maxItemsUsers: 25_000, maxItemsDevices: 25_000, maxItemsCaPolicies: 500,
      maxItemsSkus: 200, maxItemsSigninEvents: 25_000, signinEventsRpm: 6,
      continuationKey: Buffer.alloc(32, 1),
    },
    continuations: createSyncContinuationCodec({ key: Buffer.alloc(32, 1) }),
    signinLimiter: createSigninLimiter({ requestsPerMinute: 4 }),
    signinEventsLimiter: createSigninEventsLimiter({ requestsPerMinute: 6 }),
    now: () => new Date('2026-09-08T12:00:00.000Z'),
  };
}
