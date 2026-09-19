import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  dbUpdate: vi.fn(),
  queueDelivery: vi.fn(),
  toWorkerWebhookConfig: vi.fn(),
}));

vi.mock('../db', () => ({ db: { select: mocks.dbSelect, insert: mocks.dbInsert, update: mocks.dbUpdate } }));
vi.mock('../workers/webhookDelivery', () => ({ getWebhookWorker: () => ({ queueDelivery: mocks.queueDelivery }) }));
vi.mock('../routes/webhooks', () => ({ toWorkerWebhookConfig: mocks.toWorkerWebhookConfig }));

vi.mock('../db/schema/integrations', () => ({
  webhooks: { id: 'id', orgId: 'orgId', name: 'name', url: 'url', status: 'status', events: 'events', successCount: 'successCount', failureCount: 'failureCount', lastDeliveryAt: 'lastDeliveryAt', lastSuccessAt: 'lastSuccessAt', createdAt: 'createdAt' },
  webhookDeliveries: { id: 'id', webhookId: 'webhookId', eventType: 'eventType', eventId: 'eventId', payload: 'payload', status: 'status', attempts: 'attempts', createdAt: 'createdAt', deliveredAt: 'deliveredAt', responseStatus: 'responseStatus', responseTimeMs: 'responseTimeMs', errorMessage: 'errorMessage' },
  psaConnections: { id: 'id', orgId: 'orgId', provider: 'provider', name: 'name', enabled: 'enabled', lastSyncAt: 'lastSyncAt', lastSyncStatus: 'lastSyncStatus', lastSyncError: 'lastSyncError', createdAt: 'createdAt' },
  psaTicketMappings: { id: 'id', connectionId: 'connectionId' },
}));

vi.mock('./secretCrypto', () => ({ decryptForColumn: vi.fn() }));
vi.mock('./notificationSenders/webhookSender', () => ({ redactUrlForLogs: vi.fn((u: string) => u) }));

import type { AuthContext } from '../middleware/auth';
import { registerIntegrationTools } from './aiToolsIntegrations';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const WEBHOOK_ID = '22222222-2222-2222-2222-222222222222';

function makeAuth(allowedSiteIds: string[] | undefined): AuthContext {
  return {
    user: { id: 'user-1', email: 'user@example.com', name: 'Test User', isPlatformAdmin: false },
    token: {} as never,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    allowedSiteIds,
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function handlerFor(name: string) {
  const reg = new Map<string, any>();
  registerIntegrationTools(reg);
  return reg.get(name)!.handler;
}

describe('test_webhook — site-ceiling gate (contract §2)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['restricted to one site', ['s1']],
    ['restricted to zero sites', []],
  ])('%s: denied before any DB access', async (_label, allowedSiteIds) => {
    const result = JSON.parse(await handlerFor('test_webhook')({ webhookId: WEBHOOK_ID }, makeAuth(allowedSiteIds as string[])));
    expect(result.error).toMatch(/site-restricted/i);
    expect(mocks.dbSelect).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });

  it('unrestricted caller is unaffected', async () => {
    mocks.dbSelect.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([{ id: WEBHOOK_ID, orgId: ORG_ID, url: 'https://example.com' }]) }) }),
    });
    mocks.dbInsert.mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([{ id: 'delivery-1', createdAt: new Date() }]) }),
    });
    mocks.toWorkerWebhookConfig.mockReturnValue({ id: WEBHOOK_ID });
    mocks.queueDelivery.mockResolvedValue(undefined);
    const result = JSON.parse(await handlerFor('test_webhook')({ webhookId: WEBHOOK_ID }, makeAuth(undefined)));
    expect(result.error).toBeUndefined();
    expect(mocks.dbSelect).toHaveBeenCalled();
  });
});
