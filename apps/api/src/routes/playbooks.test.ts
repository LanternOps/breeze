import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { playbookRoutes } from './playbooks';

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    hostname: 'devices.hostname',
  },
  playbookDefinitions: {
    id: 'playbookDefinitions.id',
    orgId: 'playbookDefinitions.orgId',
    isActive: 'playbookDefinitions.isActive',
    isBuiltIn: 'playbookDefinitions.isBuiltIn',
    name: 'playbookDefinitions.name',
    description: 'playbookDefinitions.description',
    category: 'playbookDefinitions.category',
    steps: 'playbookDefinitions.steps',
    requiredPermissions: 'playbookDefinitions.requiredPermissions',
  },
  playbookExecutions: {
    id: 'playbookExecutions.id',
    orgId: 'playbookExecutions.orgId',
    deviceId: 'playbookExecutions.deviceId',
    playbookId: 'playbookExecutions.playbookId',
    status: 'playbookExecutions.status',
    currentStepIndex: 'playbookExecutions.currentStepIndex',
    steps: 'playbookExecutions.steps',
    errorMessage: 'playbookExecutions.errorMessage',
    rollbackExecuted: 'playbookExecutions.rollbackExecuted',
    startedAt: 'playbookExecutions.startedAt',
    completedAt: 'playbookExecutions.completedAt',
    triggeredBy: 'playbookExecutions.triggeredBy',
    createdAt: 'playbookExecutions.createdAt',
  },
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
      scope: 'organization',
      partnerId: null,
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      orgCondition: () => undefined,
      canAccessOrg: () => true,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../services/playbookPermissions', () => ({
  checkPlaybookRequiredPermissions: vi.fn(),
}));

import { db } from '../db';
import { checkPlaybookRequiredPermissions } from '../services/playbookPermissions';

const PLAYBOOK_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '22222222-2222-2222-2222-222222222222';
const EXECUTION_ID = '33333333-3333-3333-3333-333333333333';

describe('playbook routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/playbooks', playbookRoutes);
  });

  it('denies execution when caller lacks required playbook permissions', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: PLAYBOOK_ID,
            name: 'Disk Cleanup',
            isActive: true,
            requiredPermissions: ['scripts:execute'],
          }]),
        }),
      }),
    } as any);
    vi.mocked(checkPlaybookRequiredPermissions).mockResolvedValueOnce({
      allowed: false,
      missingPermissions: ['scripts:execute'],
    });

    const res = await app.request(`/playbooks/${PLAYBOOK_ID}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.missingPermissions).toEqual(['scripts:execute']);
  });

  it('creates an execution record when permissions and access checks pass', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PLAYBOOK_ID,
              name: 'Service Restart',
              description: 'Restart a service and verify health',
              category: 'service',
              steps: [],
              orgId: '11111111-1111-1111-1111-111111111111',
              isBuiltIn: false,
              isActive: true,
              requiredPermissions: ['devices:execute'],
            }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DEVICE_ID,
              orgId: '11111111-1111-1111-1111-111111111111',
              hostname: 'server-01',
            }]),
          }),
        }),
      } as any);
    vi.mocked(checkPlaybookRequiredPermissions).mockResolvedValueOnce({
      allowed: true,
      missingPermissions: [],
    });
    vi.mocked(db.insert).mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{
          id: EXECUTION_ID,
          status: 'pending',
          currentStepIndex: 0,
        }]),
      }),
    } as any);

    const res = await app.request(`/playbooks/${PLAYBOOK_ID}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID, variables: { serviceName: 'nginx' } }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.id).toBe(EXECUTION_ID);
    expect(body.playbook.id).toBe(PLAYBOOK_ID);
    expect(body.device.id).toBe(DEVICE_ID);
  });

  it('rejects execution when playbook and device orgs do not match', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: PLAYBOOK_ID,
              name: 'Service Restart',
              description: 'Restart a service and verify health',
              category: 'service',
              steps: [],
              orgId: '11111111-1111-1111-1111-111111111111',
              isBuiltIn: false,
              isActive: true,
              requiredPermissions: ['devices:execute'],
            }]),
          }),
        }),
      } as any)
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: DEVICE_ID,
              orgId: '99999999-9999-9999-9999-999999999999',
              hostname: 'server-02',
            }]),
          }),
        }),
      } as any);
    vi.mocked(checkPlaybookRequiredPermissions).mockResolvedValueOnce({
      allowed: true,
      missingPermissions: [],
    });

    const res = await app.request(`/playbooks/${PLAYBOOK_ID}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ deviceId: DEVICE_ID }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain('same organization');
  });

  it('rejects invalid execution status transitions', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{
            id: EXECUTION_ID,
            status: 'pending',
          }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid execution status transition');
  });

  it('allows valid transition pending → running', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'pending' }]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'running' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.status).toBe('running');
  });

  it('allows valid transition running → completed', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'completed' }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(200);
  });

  it('allows valid transition running → failed with error message', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: EXECUTION_ID, status: 'failed', errorMessage: 'Disk still full',
          }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'failed', errorMessage: 'Disk still full' }),
    });

    expect(res.status).toBe(200);
  });

  it('allows valid transition running → rolled_back', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: EXECUTION_ID, status: 'rolled_back', rollbackExecuted: true,
          }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'rolled_back', rollbackExecuted: true }),
    });

    expect(res.status).toBe(200);
  });

  it.each([
    ['completed', 'running'],
    ['completed', 'pending'],
    ['failed', 'running'],
    ['failed', 'completed'],
    ['rolled_back', 'running'],
    ['rolled_back', 'completed'],
    ['cancelled', 'running'],
    ['cancelled', 'completed'],
  ])('rejects terminal transition %s → %s', async (from, to) => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: from }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: to }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain('Invalid execution status transition');
  });

  it('returns 409 on concurrent modification (optimistic lock)', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);
    // update returns empty — another process changed the status between select and update
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'completed' }),
    });

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain('modified concurrently');
  });

  it('rejects PATCH with empty body', async () => {
    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects PATCH with invalid status enum', async () => {
    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'done' }),
    });

    expect(res.status).toBe(400);
  });

  it('rejects PATCH with invalid UUID param', async () => {
    const res = await app.request('/playbooks/executions/not-a-uuid', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({ status: 'running' }),
    });

    expect(res.status).toBe(400);
  });

  it('updates step results and currentStepIndex without status change', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([{ id: EXECUTION_ID, status: 'running' }]),
        }),
      }),
    } as any);
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{
            id: EXECUTION_ID,
            status: 'running',
            currentStepIndex: 1,
            steps: [{ stepIndex: 0, stepName: 'Check disk', status: 'completed' }],
          }]),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        currentStepIndex: 1,
        steps: [{ stepIndex: 0, stepName: 'Check disk', status: 'completed' }],
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.execution.currentStepIndex).toBe(1);
  });

  it('returns 404 for execution details when execution is not accessible', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    } as any);

    const res = await app.request(`/playbooks/executions/${EXECUTION_ID}`, {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(404);
  });

  it('lists playbook execution history', async () => {
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        leftJoin: vi.fn().mockReturnValue({
          leftJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    execution: { id: EXECUTION_ID, status: 'completed' },
                    playbook: { id: PLAYBOOK_ID, name: 'Disk Cleanup', category: 'disk' },
                    device: { id: DEVICE_ID, hostname: 'server-01' },
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    } as any);

    const res = await app.request('/playbooks/executions?limit=10', {
      method: 'GET',
      headers: { Authorization: 'Bearer token' },
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executions).toHaveLength(1);
    expect(body.executions[0].execution.id).toBe(EXECUTION_ID);
  });
});
