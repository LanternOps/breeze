import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #3826 Wave 4A Task 3: `playbook_executions.triggered_by_user_id` FK-
 * references `users.id` (schema/playbooks.ts:118), but an `ai_agent`
 * principal's `auth.user.id` is the agent's `ai_agents.id` — see
 * services/aiAgents/agentAuthContext.ts. `execute_playbook` passed
 * `auth.user.id` straight into that FK column, which would die on a 23503 the
 * first time an agent-released run reached here. This suite pins the
 * users-row probe-and-degrade fix (mirrors the shipped
 * commandQueue.ts:855-889 precedent): a non-resolving id degrades to NULL,
 * the existing `triggered_by: 'ai'` varchar tag is untouched, and a
 * real-user id stays byte-identical.
 */

vi.mock('../db', () => ({ db: { select: vi.fn(), insert: vi.fn() } }));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerPlaybookTools } from './aiToolsPlaybooks';

function toolMap(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerPlaybookTools(map);
  return map;
}

const ORG_ID = 'org-a';
const DEVICE_ID = 'device-1';
const PLAYBOOK_ID = 'playbook-1';

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'user-1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

const playbookRow = (o: Record<string, unknown> = {}) => ({
  id: PLAYBOOK_ID,
  orgId: ORG_ID,
  isActive: true,
  isBuiltIn: false,
  name: 'Fix disk space',
  description: 'desc',
  category: 'disk',
  requiredPermissions: [],
  steps: [],
  ...o,
});

const deviceRow = (o: Record<string, unknown> = {}) => ({
  id: DEVICE_ID,
  orgId: ORG_ID,
  siteId: null,
  status: 'online',
  hostname: 'host-1',
  ...o,
});

// Queues a `.select().from().where().limit()` chain resolving to `rows`,
// consumed by exactly ONE db.select() call.
function queueSelect(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any);
}

function mockInsert(rows: unknown[]) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
  } as any);
}

function insertedValues(): Record<string, unknown> {
  return vi.mocked(db.insert).mock.results[0]!.value.values.mock.calls[0]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execute_playbook — users-FK probe-and-degrade (#3826)', () => {
  it('degrades an agent-shaped auth.user.id to triggeredByUserId: null, keeping the "ai" tag', async () => {
    const tools = toolMap();
    const execute = tools.get('execute_playbook')!;

    queueSelect([playbookRow()]); // playbook lookup
    queueSelect([deviceRow()]); // verifyDeviceAccess
    queueSelect([]); // users probe: no row -> not a real user
    mockInsert([{ id: 'exec-1', status: 'pending', currentStepIndex: 0, createdAt: new Date() }]);

    const auth = makeAuth({
      principal: { kind: 'ai_agent', agentId: 'agent-shaped-id-1', runId: 'run-1' },
      user: { id: 'agent-shaped-id-1', email: 'agent+x@breeze.internal', name: 'Agent', isPlatformAdmin: false },
    });

    const result = await execute.handler(
      { playbookId: PLAYBOOK_ID, deviceId: DEVICE_ID },
      auth,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();

    const values = insertedValues();
    expect(values.triggeredByUserId).toBeNull();
    expect(values.triggeredBy).toBe('ai');
  });

  it('keeps triggeredByUserId when auth.user.id resolves to a real users row (byte-identical real-user path)', async () => {
    const tools = toolMap();
    const execute = tools.get('execute_playbook')!;

    queueSelect([playbookRow()]);
    queueSelect([deviceRow()]);
    queueSelect([{ id: 'user-1' }]); // users probe: real row
    mockInsert([{ id: 'exec-2', status: 'pending', currentStepIndex: 0, createdAt: new Date() }]);

    const auth = makeAuth(); // default user_session, user.id: 'user-1'
    const result = await execute.handler(
      { playbookId: PLAYBOOK_ID, deviceId: DEVICE_ID },
      auth,
    );
    const parsed = JSON.parse(result);
    expect(parsed.error).toBeUndefined();

    const values = insertedValues();
    expect(values.triggeredByUserId).toBe('user-1');
    expect(values.triggeredBy).toBe('ai');
  });

  it('probes exactly once: playbook lookup, device lookup, users probe, then insert', async () => {
    const tools = toolMap();
    const execute = tools.get('execute_playbook')!;

    queueSelect([playbookRow()]);
    queueSelect([deviceRow()]);
    queueSelect([{ id: 'user-1' }]);
    mockInsert([{ id: 'exec-3', status: 'pending', currentStepIndex: 0, createdAt: new Date() }]);

    await execute.handler({ playbookId: PLAYBOOK_ID, deviceId: DEVICE_ID }, makeAuth());

    expect(db.select).toHaveBeenCalledTimes(3);
  });
});
