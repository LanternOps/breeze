/**
 * Security regression test: AI-tool notification-channel create/update paths
 * must validate config and encrypt secret fields before persisting — mirroring
 * the canonical HTTP route (apps/api/src/routes/alerts/channels.ts).
 *
 * Ensures plaintext secrets never land in the DB via the AI tool path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---- hoisted mocks -------------------------------------------------------

const mocks = vi.hoisted(() => ({
  dbInsert: vi.fn(),
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  encryptNotificationChannelConfig: vi.fn(),
  decryptNotificationChannelConfig: vi.fn(),
  validateNotificationChannelConfig: vi.fn(),
  publishEvent: vi.fn().mockResolvedValue('event-1'),
  emitAlertStateFeedback: vi.fn().mockResolvedValue(undefined),
  resolveSiteAllowedDeviceIds: vi.fn().mockResolvedValue(null),
  deviceIdSiteDenied: vi.fn().mockReturnValue(false),
}));

vi.mock('../db', () => ({
  db: {
    insert: mocks.dbInsert,
    select: mocks.dbSelect,
    update: mocks.dbUpdate,
  },
}));

vi.mock('./notificationChannelSecrets', () => ({
  encryptNotificationChannelConfig: mocks.encryptNotificationChannelConfig,
  decryptNotificationChannelConfig: mocks.decryptNotificationChannelConfig,
}));

vi.mock('../routes/alerts/helpers', () => ({
  validateNotificationChannelConfig: mocks.validateNotificationChannelConfig,
}));

vi.mock('./eventBus', () => ({
  publishEvent: mocks.publishEvent,
}));

vi.mock('./mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: mocks.emitAlertStateFeedback,
}));

vi.mock('./aiToolsSiteScope', () => ({
  resolveSiteAllowedDeviceIds: mocks.resolveSiteAllowedDeviceIds,
  deviceIdSiteDenied: mocks.deviceIdSiteDenied,
}));

// ---- imports (after mocks) -----------------------------------------------

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAlertTools } from './aiToolsAlerts';

// ---- helpers ----------------------------------------------------------------

function getHandler(name: string): AiTool['handler'] {
  const registry = new Map<string, AiTool>();
  registerAlertTools(registry);
  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool.handler;
}

function makeAuth(orgId = 'org-1'): AuthContext {
  return {
    user: {
      id: '11111111-1111-4111-8111-111111111111',
      email: 'user@example.com',
      name: 'User',
      isPlatformAdmin: false,
    },
    token: {} as never,
    partnerId: null,
    orgId,
    scope: 'organization',
    accessibleOrgIds: [orgId],
    orgCondition: () => undefined,
    canAccessOrg: (id: string) => id === orgId,
  } as unknown as AuthContext;
}

const PLAINTEXT_WEBHOOK_URL = 'https://hooks.slack.com/services/SECRET_TOKEN';
const ENCRYPTED_STUB = 'enc:v3:stubCiphertext';

const SLACK_CONFIG = { webhookUrl: PLAINTEXT_WEBHOOK_URL };
const ENCRYPTED_CONFIG = { webhookUrl: ENCRYPTED_STUB };

// ---- tests: create ----------------------------------------------------------

describe('manage_notification_channels — create action', () => {
  let handler: AiTool['handler'];

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('manage_notification_channels');
  });

  it('validates config before insert and returns error on invalid config', async () => {
    mocks.validateNotificationChannelConfig.mockReturnValue(['webhookUrl must be a non-empty string']);

    const result = JSON.parse(
      await handler(
        { action: 'create', name: 'My Slack', type: 'slack', config: { webhookUrl: '' }, enabled: true },
        makeAuth(),
      ) as string,
    );

    expect(mocks.validateNotificationChannelConfig).toHaveBeenCalledWith('slack', { webhookUrl: '' });
    expect(mocks.encryptNotificationChannelConfig).not.toHaveBeenCalled();
    expect(mocks.dbInsert).not.toHaveBeenCalled();
    expect(result.error).toMatch(/invalid/i);
    expect(result.details).toContain('webhookUrl must be a non-empty string');
  });

  it('encrypts config before insert when validation passes', async () => {
    mocks.validateNotificationChannelConfig.mockReturnValue([]);
    mocks.encryptNotificationChannelConfig.mockReturnValue(ENCRYPTED_CONFIG);

    const insertReturningMock = vi.fn().mockResolvedValue([
      { id: 'chan-1', name: 'My Slack', type: 'slack' },
    ]);
    const insertValuesMock = vi.fn(() => ({ returning: insertReturningMock }));
    mocks.dbInsert.mockReturnValue({ values: insertValuesMock });

    const result = JSON.parse(
      await handler(
        { action: 'create', name: 'My Slack', type: 'slack', config: SLACK_CONFIG, enabled: true },
        makeAuth(),
      ) as string,
    );

    // validate was called with the raw (plaintext) config
    expect(mocks.validateNotificationChannelConfig).toHaveBeenCalledWith('slack', SLACK_CONFIG);

    // encrypt was called before insert
    expect(mocks.encryptNotificationChannelConfig).toHaveBeenCalledWith('slack', SLACK_CONFIG);

    // the value passed to db.insert().values() must use the ENCRYPTED config
    const insertedValues = (insertValuesMock.mock.calls[0] as any)[0] as Record<string, unknown>;
    expect(insertedValues.config).toEqual(ENCRYPTED_CONFIG);
    // plaintext secret must NOT be stored
    expect(JSON.stringify(insertedValues.config)).not.toContain(PLAINTEXT_WEBHOOK_URL);

    expect(result.success).toBe(true);
    expect(result.channelId).toBe('chan-1');
  });

  it('returns error when org context is missing', async () => {
    const auth = makeAuth('org-1');
    auth.orgId = null as unknown as string;
    (auth as unknown as { accessibleOrgIds: string[] }).accessibleOrgIds = [];

    const result = JSON.parse(
      await handler(
        { action: 'create', name: 'X', type: 'slack', config: SLACK_CONFIG },
        auth,
      ) as string,
    );

    expect(result.error).toMatch(/organization context required/i);
    expect(mocks.dbInsert).not.toHaveBeenCalled();
  });
});

// ---- tests: update ----------------------------------------------------------

describe('manage_notification_channels — update action', () => {
  let handler: AiTool['handler'];

  const EXISTING_CHANNEL = {
    id: 'chan-1',
    orgId: 'org-1',
    name: 'My Slack',
    type: 'slack',
    config: { webhookUrl: ENCRYPTED_STUB },
    enabled: true,
  };

  function mockChannelLookup(channel: unknown | null) {
    mocks.dbSelect.mockReturnValueOnce({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(channel ? [channel] : []),
        })),
      })),
    });
  }

  function mockUpdateChain() {
    mocks.dbUpdate.mockReturnValueOnce({
      set: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(undefined),
      })),
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handler = getHandler('manage_notification_channels');
  });

  it('validates merged config and returns error on invalid config', async () => {
    mockChannelLookup(EXISTING_CHANNEL);

    const mergedEncrypted = { webhookUrl: 'enc:v3:new' };
    mocks.encryptNotificationChannelConfig.mockReturnValue(mergedEncrypted);
    mocks.decryptNotificationChannelConfig.mockReturnValue({ webhookUrl: '' });
    mocks.validateNotificationChannelConfig.mockReturnValue(['webhookUrl must be a non-empty string']);

    const result = JSON.parse(
      await handler(
        { action: 'update', channelId: 'chan-1', config: { webhookUrl: '' } },
        makeAuth(),
      ) as string,
    );

    expect(mocks.validateNotificationChannelConfig).toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
    expect(result.error).toMatch(/invalid/i);
    expect(result.details).toContain('webhookUrl must be a non-empty string');
  });

  it('encrypts config (merging with existing) before update when validation passes', async () => {
    mockChannelLookup(EXISTING_CHANNEL);

    const newPlainConfig = { webhookUrl: 'https://hooks.slack.com/services/NEW_TOKEN' };
    const mergedEncrypted = { webhookUrl: 'enc:v3:newEncrypted' };
    const decryptedForValidation = { webhookUrl: 'https://hooks.slack.com/services/NEW_TOKEN' };

    mocks.encryptNotificationChannelConfig.mockReturnValue(mergedEncrypted);
    mocks.decryptNotificationChannelConfig.mockReturnValue(decryptedForValidation);
    mocks.validateNotificationChannelConfig.mockReturnValue([]);

    const setMock = vi.fn(() => ({ where: vi.fn().mockResolvedValue(undefined) }));
    mocks.dbUpdate.mockReturnValue({ set: setMock });

    const result = JSON.parse(
      await handler(
        { action: 'update', channelId: 'chan-1', config: newPlainConfig },
        makeAuth(),
      ) as string,
    );

    // encrypt was called with incoming config AND existing config (for merge)
    expect(mocks.encryptNotificationChannelConfig).toHaveBeenCalledWith(
      'slack',
      newPlainConfig,
      EXISTING_CHANNEL.config,
    );

    // decrypt was called on the merged result for validation
    expect(mocks.decryptNotificationChannelConfig).toHaveBeenCalledWith('slack', mergedEncrypted);

    // validate was called on the decrypted form
    expect(mocks.validateNotificationChannelConfig).toHaveBeenCalledWith('slack', decryptedForValidation);

    // the value passed to db.update().set() must store the ENCRYPTED merged config
    const setCallArg = (setMock.mock.calls[0] as any)[0] as Record<string, unknown>;
    expect(setCallArg.config).toEqual(mergedEncrypted);
    // plaintext must NOT appear in the persisted value
    expect(JSON.stringify(setCallArg.config)).not.toContain('NEW_TOKEN');

    expect(result.success).toBe(true);
  });

  it('skips encrypt/validate when no config is provided in update', async () => {
    mockChannelLookup(EXISTING_CHANNEL);
    mockUpdateChain();

    const result = JSON.parse(
      await handler(
        { action: 'update', channelId: 'chan-1', name: 'Renamed Channel' },
        makeAuth(),
      ) as string,
    );

    expect(mocks.encryptNotificationChannelConfig).not.toHaveBeenCalled();
    expect(mocks.validateNotificationChannelConfig).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('returns error when channel not found', async () => {
    mockChannelLookup(null);

    const result = JSON.parse(
      await handler(
        { action: 'update', channelId: 'nonexistent', config: SLACK_CONFIG },
        makeAuth(),
      ) as string,
    );

    expect(result.error).toMatch(/not found/i);
    expect(mocks.encryptNotificationChannelConfig).not.toHaveBeenCalled();
    expect(mocks.dbUpdate).not.toHaveBeenCalled();
  });
});
