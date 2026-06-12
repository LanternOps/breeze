import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

// Mirror the db/schema/middleware mock shape used by the sibling index.test.ts
// harness so helperAuth resolves an authenticated device for our request.
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
}));

vi.mock('../../db/schema', () => ({
  aiMessages: {},
  aiSessions: {
    id: 'aiSessions.id',
    deviceId: 'aiSessions.deviceId',
    updatedAt: 'aiSessions.updatedAt',
  },
  aiToolExecutions: {},
  devices: {
    id: 'devices.id',
    agentId: 'devices.agentId',
    orgId: 'devices.orgId',
    siteId: 'devices.siteId',
    hostname: 'devices.hostname',
    osType: 'devices.osType',
    osVersion: 'devices.osVersion',
    agentVersion: 'devices.agentVersion',
    helperTokenHash: 'devices.helperTokenHash',
    previousHelperTokenHash: 'devices.previousHelperTokenHash',
    previousHelperTokenExpiresAt: 'devices.previousHelperTokenExpiresAt',
    status: 'devices.status',
  },
  organizations: {
    id: 'organizations.id',
    partnerId: 'organizations.partnerId',
  },
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((...args: unknown[]) => ({ eq: args })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
  or: vi.fn((...args: unknown[]) => ({ or: args })),
  desc: vi.fn((...args: unknown[]) => ({ desc: args })),
  asc: vi.fn((...args: unknown[]) => ({ asc: args })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ sql: strings, values })),
}));

vi.mock('../../middleware/agentAuth', () => ({
  matchAgentTokenHash: vi.fn(() => true),
}));

vi.mock('../../services/helperPermissions', () => ({
  resolveHelperPermissionLevelForDevice: vi.fn(),
}));

vi.mock('../../services/helperAiAgent', () => ({
  buildHelperSystemPrompt: vi.fn(() => 'helper system prompt'),
}));

vi.mock('../../services/streamingSessionManager', () => ({
  streamingSessionManager: {
    getOrCreate: vi.fn(),
    tryTransitionToProcessing: vi.fn(),
    startTurnTimeout: vi.fn(),
    remove: vi.fn(),
  },
}));

vi.mock('../../services/aiInputSanitizer', () => ({
  sanitizeUserMessage: vi.fn(() => ({ sanitized: 'hello', flags: [] })),
}));

vi.mock('../../services/screenshotStorage', () => ({
  storeScreenshot: vi.fn(),
}));

vi.mock('../../services/aiCostTracker', () => ({
  checkBudget: vi.fn(),
  getRemainingBudgetUsd: vi.fn(),
}));

vi.mock('../../services', () => ({
  getRedis: vi.fn(() => null),
  rateLimiter: vi.fn(),
}));

vi.mock('../../services/aiAgentSdk', () => ({
  createSessionPreToolUse: vi.fn(),
  createSessionPostToolUse: vi.fn(),
}));

import { helperRoutes } from './index';
import { db } from '../../db';

function mockHelperAuthDevice() {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: 'device-1',
            agentId: 'agent-1',
            orgId: 'org-1',
            siteId: 'site-1',
            hostname: 'host-1',
            osType: 'linux',
            osVersion: '6.8',
            agentVersion: '1.0.0',
            helperTokenHash: 'hash',
            previousHelperTokenHash: null,
            previousHelperTokenExpiresAt: null,
            status: 'online',
            partnerId: 'partner-1',
          }]),
        }),
      }),
    }),
  } as never);
}

describe('Helper self-approve endpoint removal (finding A)', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/helper', helperRoutes);
  });

  it('POST /chat/sessions/:id/approve/:executionId no longer exists (404)', async () => {
    mockHelperAuthDevice();
    const res = await app.request('/helper/chat/sessions/s-1/approve/e-1', {
      method: 'POST',
      headers: { Authorization: 'Bearer brz_token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(res.status).toBe(404);
  });
});
