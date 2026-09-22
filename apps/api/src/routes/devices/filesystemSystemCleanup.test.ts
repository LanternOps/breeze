import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  selectMock, insertMock, updateMock,
  queueCommandForExecutionMock, getDeviceWithOrgAndSiteCheckMock, writeRouteAuditMock,
} = vi.hoisted(() => ({
  selectMock: vi.fn(),
  insertMock: vi.fn(),
  updateMock: vi.fn(),
  queueCommandForExecutionMock: vi.fn(),
  getDeviceWithOrgAndSiteCheckMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  eq: (left: unknown, right: unknown) => ({ type: 'eq', left, right }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: 'sql', strings: [...strings], values }),
}));

vi.mock('../../db', () => ({
  db: { select: selectMock, insert: insertMock, update: updateMock,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      select: (...args: unknown[]) => ({ from: (table: { id: string }) => table.id === 'devices.id'
        ? { where: () => ({ for: async () => [{ id: DEVICE_ID }] }) }
        : selectMock(...args).from(table) }),
      insert: insertMock, update: updateMock,
    }),
  },
  withDbAccessContext: async (_ctx: unknown, fn: () => Promise<unknown>) => fn(),
  runOutsideDbContext: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock('../../db/schema', () => ({
  devices: { id: 'devices.id', orgId: 'devices.orgId' },
  deviceCommands: { id: 'deviceCommands.id', deviceId: 'deviceCommands.deviceId', type: 'deviceCommands.type', status: 'deviceCommands.status', payload: 'deviceCommands.payload' },
  deviceFilesystemCleanupRuns: {
    id: 'runs.id', deviceId: 'runs.deviceId', orgId: 'runs.orgId', kind: 'runs.kind',
    status: 'runs.status', commandId: 'runs.commandId', requestedAt: 'runs.requestedAt',
  },
}));

/** The rows the CAS `UPDATE … WHERE status = 'running' RETURNING` yields, then every later update's. */
function updateReturning(...perCall: unknown[][]) {
  const queue = [...perCall];
  updateMock.mockImplementation(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => Object.assign(Promise.resolve([]), { returning: async () => queue.shift() ?? [] }),
      _set: values,
    }),
  }));
}

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', { user: { id: 'user-1', email: 't@example.com' }, orgId: 'org-1', scope: 'organization' });
    return next();
  }),
  requirePermission: vi.fn(() => async (_c: any, next: any) => next()),
  requireScope: vi.fn(() => async (_c: any, next: any) => next()),
  withAuthDbAccessContext: async (_auth: unknown, fn: () => Promise<unknown>) => fn(),
  requireMfa: vi.fn(() => async (_c: any, next: any) => next()),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: { DEVICES_READ: { resource: 'devices', action: 'read' }, DEVICES_EXECUTE: { resource: 'devices', action: 'execute' } },
}));

vi.mock('../../services/commandQueue', () => ({
  CommandTypes: { SYSTEM_CLEANUP_LIST: 'system_cleanup_list', SYSTEM_CLEANUP_RUN: 'system_cleanup_run' },
  queueCommandForExecutionWithSystemPrecheck: queueCommandForExecutionMock,
}));

vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

// No mock of services/systemCleanup: the gate, the schemas, the queue/start
// seam and the shared run-status resolver (with its cancel-and-fail
// transaction) all run for real against the mocked db above.

vi.mock('./helpers', () => ({
  SITE_ACCESS_DENIED: Symbol.for('site-access-denied'),
  getDeviceWithOrgAndSiteCheck: getDeviceWithOrgAndSiteCheckMock,
}));

import { filesystemSystemCleanupRoutes } from './filesystemSystemCleanup';
import { MIN_AGENT_VERSION_SYSTEM_CLEANUP } from '../../services/systemCleanup';

const DEVICE_ID = '22222222-2222-4222-8222-222222222222';
const COMMAND_ID = '33333333-3333-4333-8333-333333333333';
const RUN_ID = '44444444-4444-4444-8444-444444444444';

const modernDevice = { id: DEVICE_ID, orgId: 'org-1', hostname: 'LAB-1', agentVersion: '0.115.0' };

function app() {
  const instance = new Hono();
  instance.route('/devices', filesystemSystemCleanupRoutes);
  return instance;
}

function selectReturning(rows: unknown[]) {
  return { from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }) };
}

const catalog = {
  catalogVersion: 1,
  actions: [{
    id: 'linux_pkg_cache_clean', label: 'Package manager cache', description: 'Removes archives.',
    os: 'linux', available: true, estimateBytes: 412_000_000, estimateKnown: true,
    riskFlags: [], affectsVolumes: ['/'],
  }],
  volumesBefore: [{ mount: '/', freeBytes: 9_000_000_000 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  selectMock.mockReturnValue(selectReturning([]));
  getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(modernDevice);
  queueCommandForExecutionMock.mockResolvedValue({ command: { id: COMMAND_ID, status: 'pending', createdAt: new Date('2026-09-19T10:00:00Z') } });
});

describe('POST /devices/:id/filesystem/system-cleanup/list', () => {
  it('queues the list command and audits it', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { commandId: COMMAND_ID } });
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(DEVICE_ID, 'system_cleanup_list', {}, { userId: 'user-1', expectedOrgId: 'org-1' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.list',
    }));
  });

  // Spec §5.3: the gate runs BEFORE queuing, so a stale agent never gets a
  // command it will answer with a bare failure.
  it('refuses an agent below the minimum with 409 agent_update_required', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue({ ...modernDevice, agentVersion: '0.114.0' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
    });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  it('refuses a device with no usable agent version (fail closed)', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue({ ...modernDevice, agentVersion: '' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });
});

describe('GET /devices/:id/filesystem/system-cleanup/list/:commandId', () => {
  it('reports running while the command is pending', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'pending', result: null }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { status: 'running' } });
  });

  // Plan amendment 6: the generic GET /devices/:id/commands/:commandId
  // redacts stdout for every type but capture_pprof, so the catalogue has to
  // be read off the row server-side.
  it('returns the validated catalogue once the command completes', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'completed',
      result: { status: 'completed', exitCode: 0, stdout: JSON.stringify(catalog) },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('completed');
    expect(body.data.catalog.actions[0].id).toBe('linux_pkg_cache_clean');
  });

  // Spec §5.3's defensive fallback. It can only live on a route we own — the
  // generic command GET always answers 200 with the row.
  it('turns the agent "unknown command type:" failure into the same 409', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'failed',
      result: { status: 'failed', exitCode: 1, error: 'unknown command type: system_cleanup_list' },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      success: false, error: 'agent_update_required', minAgentVersion: MIN_AGENT_VERSION_SYSTEM_CLEANUP,
    });
  });

  it('answers 502 rather than an empty catalogue when the agent output is unreadable', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: COMMAND_ID, deviceId: DEVICE_ID, type: 'system_cleanup_list', status: 'completed',
      result: { status: 'completed', exitCode: 0, stdout: 'not json' },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({ success: false });
  });

  it('404s a command of another type or another device', async () => {
    selectMock.mockReturnValue(selectReturning([]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /devices/:id/filesystem/system-cleanup/run', () => {
  beforeEach(() => {
    insertMock.mockReturnValue({ values: () => ({ returning: () => Promise.resolve([{ id: RUN_ID }]) }) });
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.resolve([{ id: RUN_ID }]) }) });
  });

  it('records a running system run, queues the command and links the two', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'], params: { journalVacuumBytes: 268435456 } }),
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { cleanupRunId: RUN_ID, commandId: COMMAND_ID } });
    expect(queueCommandForExecutionMock).toHaveBeenCalledWith(
      DEVICE_ID, 'system_cleanup_run',
      { runId: RUN_ID, actionIds: ['linux_pkg_cache_clean'], params: { journalVacuumBytes: 268435456 } },
      { userId: 'user-1', expectedOrgId: 'org-1' },
    );
    // The row exists BEFORE the command is queued, so a result that arrives
    // before this handler returns still has a row to close.
    expect(insertMock.mock.invocationCallOrder[0]).toBeLessThan(queueCommandForExecutionMock.mock.invocationCallOrder[0]!);
  });

  it('rejects an id outside the shared catalogue with 400', async () => {
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['win_cleanmgr:DownloadsFolder'] }),
    });
    expect(res.status).toBe(400);
    expect(insertMock).not.toHaveBeenCalled();
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  // Spec §13 #4: one native run per device. The claim's committed transaction
  // is what makes this check see a row a concurrent request just wrote.
  it('refuses a second run while one is already running on the device', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: RUN_ID }])); // an in-flight system run
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false, error: 'run_in_progress', cleanupRunId: RUN_ID });
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });

  // Spec §13 #14: the deadline is derived from the SELECTION and stored, so
  // the poll route never recomputes it. cleanmgr (60) + DISM (90) + 10 = 160.
  it('stores a per-selection deadline on the run row', async () => {
    const valuesSpy = vi.fn((_values: unknown) => ({ returning: () => Promise.resolve([{ id: RUN_ID }]) }));
    insertMock.mockReturnValue({ values: valuesSpy });
    await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['win_cleanmgr', 'win_dism_component_cleanup'] }),
    });
    const written = valuesSpy.mock.calls[0]?.[0] as { plan: { deadlineAt: string } };
    const budgetMs = new Date(written.plan.deadlineAt).getTime() - Date.now();
    expect(budgetMs).toBeGreaterThan(159 * 60 * 1000);
    expect(budgetMs).toBeLessThanOrEqual(160 * 60 * 1000);
  });

  it('marks the run failed when the command cannot be queued', async () => {
    queueCommandForExecutionMock.mockResolvedValue({ error: 'Device is offline' });
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
    });
    expect(res.status).toBe(500);
    // A `running` row nobody will ever close is worse than no row at all.
    expect(updateMock).toHaveBeenCalled();
  });
});

describe('GET /devices/:id/filesystem/system-cleanup/run/:cleanupRunId', () => {
  it('returns the executed run projection', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'executed', error: null,
      bytesReclaimed: 3_000, requestedAt: new Date('2026-09-19T10:00:00Z'),
      executedActions: { actions: [{ id: 'linux_pkg_cache_clean', status: 'completed', exitCode: 0 }], volumes: [{ mount: '/', freeBefore: 1_000, freeAfter: 4_000 }] },
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.status).toBe('executed');
    expect(body.data.freedBytes).toBe(3_000);
    expect(body.data.volumes[0].freeAfter).toBe(4_000);
  });

  // The lazy timeout reads the deadline STORED on the row (spec §13 #14) and
  // cancels the command in the same transaction (spec §13 #6/#13) — telling
  // the operator a run failed while its command is still deliverable is the
  // hazard the live_only TTL narrows but does not close.
  it('fails a running row past its STORED deadline and cancels its command atomically', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      plan: { actionIds: ['linux_pkg_cache_clean'], deadlineAt: new Date(Date.now() - 60_000).toISOString() },
      executedActions: [],
    }]));
    updateReturning([{ id: RUN_ID, commandId: COMMAND_ID }], [{ id: COMMAND_ID }]);

    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'failed', error: 'timed out' } });
    // runs CAS-failed, then the pending command cancelled — in that order.
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[0]![0]).toMatchObject({ id: 'runs.id' });
    expect(updateMock.mock.calls[1]![0]).toMatchObject({ id: 'deviceCommands.id' });
  });

  // The deadline is per-selection: a 20-minute-old run of a 160-minute
  // selection is NOT late, which a flat two-hour constant could not express
  // in the other direction either.
  it('leaves a running row inside its stored deadline alone', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 20 * 60 * 1000),
      plan: { actionIds: ['win_cleanmgr', 'win_dism_component_cleanup'], deadlineAt: new Date(Date.now() + 140 * 60 * 1000).toISOString() },
      executedActions: [],
    }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'running' } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  // A row written before plan.deadlineAt existed falls back to the ceiling,
  // which is the conservative direction — it waits longer, never less.
  it('falls back to the three-hour ceiling when the row carries no stored deadline', async () => {
    selectMock.mockReturnValue(selectReturning([{
      id: RUN_ID, deviceId: DEVICE_ID, kind: 'system', status: 'running', error: null,
      bytesReclaimed: 0, requestedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      plan: { actionIds: ['linux_pkg_cache_clean'] }, executedActions: [],
    }]));
    await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('404s a file-kind run — this projection is for system runs only', async () => {
    selectMock.mockReturnValue(selectReturning([]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(404);
  });
});


describe('system-cleanup access and poll failures', () => {
  const paths = [
    ['POST', 'list'], ['POST', 'run'],
    ['GET', `list/${COMMAND_ID}`], ['GET', `run/${RUN_ID}`],
  ] as const;
  it.each(paths)('%s %s denies inaccessible organizations before querying commands', async (method, path) => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/${path}`, {
      method, ...(method === 'POST' && path === 'run' ? {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
      } : {}),
    });
    expect(res.status).toBe(404);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });
  it.each(paths)('%s %s denies an excluded site', async (method, path) => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(Symbol.for('site-access-denied'));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/${path}`, {
      method, ...(method === 'POST' && path === 'run' ? {
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ actionIds: ['linux_pkg_cache_clean'] }),
      } : {}),
    });
    expect(res.status).toBe(403);
    expect(queueCommandForExecutionMock).not.toHaveBeenCalled();
  });
  it('returns update-required when the run command reports an unknown command type', async () => {
    selectMock.mockReturnValueOnce(selectReturning([{ id: RUN_ID, commandId: COMMAND_ID, status: 'running' }]))
      .mockReturnValueOnce(selectReturning([{ result: { error: 'unknown command type: system_cleanup_run' } }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: 'agent_update_required', minAgentVersion: '0.115.0' });
  });
  it('returns update-required from the persisted run error', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: RUN_ID, status: 'failed', error: 'unknown command type: system_cleanup_run' }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}`);
    expect(res.status).toBe(409);
  });
  it('reports a cancelled catalog command as failed rather than running forever', async () => {
    selectMock.mockReturnValue(selectReturning([{ status: 'cancelled', result: null }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/list/${COMMAND_ID}`);
    await expect(res.json()).resolves.toMatchObject({ data: { status: 'failed' } });
  });
});

// #6485 F-5: `POST /devices/:id/commands/:commandId/cancel` answers 409
// "Command is not pending" the instant the agent claims the command (status
// flips to `sent`), so a hung 60-min cleaner could not be cancelled from the
// API at all — the operator had to wait out the stored deadline (up to 70
// min). This route fails the RUN row and cancels the command atomically via
// `failSystemCleanupRunAndCancelCommand`, regardless of whether the command
// is still `pending` or already `sent`/in flight.
describe('POST /devices/:id/filesystem/system-cleanup/run/:cleanupRunId/cancel', () => {
  it('fails a running run and cancels its already-sent command', async () => {
    selectMock.mockReturnValueOnce(selectReturning([{ id: RUN_ID, deviceId: DEVICE_ID, orgId: 'org-1', kind: 'system', status: 'running', commandId: COMMAND_ID }]));
    updateReturning([{ id: RUN_ID, commandId: COMMAND_ID }], [{ id: COMMAND_ID }]);

    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}/cancel`, { method: 'POST' });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ success: true, data: { cleanupRunId: RUN_ID, status: 'failed' } });
    // runs CAS-failed, then the sent/pending command cancelled — same atomic
    // helper the lazy poll timeout uses, so there is one "this run is over".
    expect(updateMock).toHaveBeenCalledTimes(2);
    expect(updateMock.mock.calls[0]![0]).toMatchObject({ id: 'runs.id' });
    expect(writeRouteAuditMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'device.filesystem.system_cleanup.cancel',
    }));
  });

  it('404s when the run does not exist', async () => {
    selectMock.mockReturnValue(selectReturning([]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('409s a run that already finished — not "not pending", not the generic command cancel answer', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: RUN_ID, deviceId: DEVICE_ID, orgId: 'org-1', kind: 'system', status: 'executed', commandId: COMMAND_ID }]));
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false, error: 'not_running', status: 'executed' });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('409s when a real result won the CAS race against the cancel', async () => {
    selectMock.mockReturnValue(selectReturning([{ id: RUN_ID, deviceId: DEVICE_ID, orgId: 'org-1', kind: 'system', status: 'running', commandId: COMMAND_ID }]));
    updateReturning([]); // the CAS `WHERE status = 'running'` matched nothing — a result landed first
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ success: false, error: 'not_running' });
  });

  it('denies an inaccessible organization before touching the run row', async () => {
    getDeviceWithOrgAndSiteCheckMock.mockResolvedValue(null);
    const res = await app().request(`/devices/${DEVICE_ID}/filesystem/system-cleanup/run/${RUN_ID}/cancel`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(selectMock).not.toHaveBeenCalled();
  });
});
