import { beforeEach, describe, expect, it, vi } from 'vitest';

const DEVICE = '00000000-0000-4000-8000-0000000000d1';
const ANOMALY = '00000000-0000-4000-8000-0000000000e1';
const ORG = '00000000-0000-4000-8000-0000000000c1';

const { routeFns, gate } = vi.hoisted(() => ({
  routeFns: { queryDeviceAnomalies: vi.fn(), applyAnomalyStatus: vi.fn() },
  gate: { verifyDeviceAccess: vi.fn() },
}));
vi.mock('../routes/devices/anomalies', async (importOriginal) => ({ ...(await importOriginal<object>()), ...routeFns }));
vi.mock('./aiTools', () => ({ ...gate }));

import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { registerAnomalyTools } from './aiToolsAnomalies';

const tools = new Map<string, AiTool>();
registerAnomalyTools(tools);
const tool = tools.get('manage_device_anomalies')!;

const makeAuth = (over: Record<string, unknown> = {}) => ({
  principal: { kind: 'user_session' }, user: { id: 'user-1' }, orgId: ORG, scope: 'organization', ...over,
}) as unknown as AuthContext;
const run = async (input: Record<string, unknown>, auth = makeAuth(), context?: Record<string, unknown>) =>
  JSON.parse(await tool.handler(input, auth, context as never)) as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  gate.verifyDeviceAccess.mockResolvedValue({ device: { id: DEVICE, orgId: ORG, siteId: 's1' } });
});

describe('manage_device_anomalies (W07)', () => {
  it('declares the central device gate and fits the description budget', () => {
    expect(tool.deviceArgs).toEqual(['deviceId']);
    const d = tool.definition.description ?? '';
    expect(d.length).toBeLessThanOrEqual(300);
    for (const a of ['list', 'dismiss', 'resolve', 'promote']) expect(d).toContain(a);
  });

  it('list resolves the device under the caller scope, then reads with the DEVICE org (never an input org)', async () => {
    routeFns.queryDeviceAnomalies.mockResolvedValue([{ id: ANOMALY, status: 'open' }]);
    const out = await run({ action: 'list', deviceId: DEVICE, status: 'all', limit: 5 });
    expect(gate.verifyDeviceAccess).toHaveBeenCalledWith(DEVICE, expect.anything());
    expect(routeFns.queryDeviceAnomalies).toHaveBeenCalledWith(ORG, DEVICE, { status: 'all', limit: 5 });
    expect(out).toMatchObject({ deviceId: DEVICE, count: 1 });
  });

  it('list defaults to open / 25 through the route schema', async () => {
    routeFns.queryDeviceAnomalies.mockResolvedValue([]);
    await run({ action: 'list', deviceId: DEVICE });
    expect(routeFns.queryDeviceAnomalies).toHaveBeenCalledWith(ORG, DEVICE, { status: 'open', limit: 25 });
  });

  it('an out-of-scope device (org, site or exact-device denial) is NOT_FOUND and nothing is read or written', async () => {
    gate.verifyDeviceAccess.mockResolvedValue({ error: 'Device not found or access denied' });
    expect(await run({ action: 'list', deviceId: DEVICE })).toMatchObject({ code: 'NOT_FOUND' });
    expect(await run({ action: 'promote', deviceId: DEVICE, anomalyId: ANOMALY })).toMatchObject({ code: 'NOT_FOUND' });
    expect(routeFns.queryDeviceAnomalies).not.toHaveBeenCalled();
    expect(routeFns.applyAnomalyStatus).not.toHaveBeenCalled();
  });

  it.each([['dismiss', 'dismissed'], ['resolve', 'resolved'], ['promote', 'promoted']] as const)(
    '%s sets status %s through the route function as the caller',
    async (action, status) => {
      routeFns.applyAnomalyStatus.mockResolvedValue({ status: 'ok', data: { id: ANOMALY, status } });
      const out = await run({ action, deviceId: DEVICE, anomalyId: ANOMALY, note: 'seen' });
      expect(routeFns.applyAnomalyStatus).toHaveBeenCalledWith({
        orgId: ORG, deviceId: DEVICE, anomalyId: ANOMALY, actorUserId: 'user-1', input: { status, note: 'seen' },
      });
      expect(out).toEqual({ anomaly: { id: ANOMALY, status } });
    },
  );

  it('maps the route function outcomes: not_found and promotion disabled', async () => {
    routeFns.applyAnomalyStatus.mockResolvedValueOnce({ status: 'not_found' });
    expect(await run({ action: 'resolve', deviceId: DEVICE, anomalyId: ANOMALY })).toMatchObject({ code: 'NOT_FOUND' });
    routeFns.applyAnomalyStatus.mockResolvedValueOnce({ status: 'disabled' });
    expect(await run({ action: 'promote', deviceId: DEVICE, anomalyId: ANOMALY })).toMatchObject({ code: 'FEATURE_DISABLED' });
  });

  it('requires a device id and, for a write, an anomaly id', async () => {
    expect(await run({ action: 'list' })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(await run({ action: 'dismiss', deviceId: DEVICE })).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(routeFns.applyAnomalyStatus).not.toHaveBeenCalled();
  });

  it('rejects a status outside the route enum for list', async () => {
    expect(await run({ action: 'list', deviceId: DEVICE, status: 'exploded' })).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describe('agent principals', () => {
    const agent = makeAuth({ principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' } });

    it('a direct ai_agent call never writes (its id is not a users row)', async () => {
      for (const action of ['dismiss', 'resolve', 'promote']) {
        expect(await run({ action, deviceId: DEVICE, anomalyId: ANOMALY }, agent), action).toEqual({ error: 'agent_principal_unsupported_action', action });
      }
      expect(routeFns.applyAnomalyStatus).not.toHaveBeenCalled();
    });

    it('an agent may list (a read)', async () => {
      routeFns.queryDeviceAnomalies.mockResolvedValue([]);
      expect(await run({ action: 'list', deviceId: DEVICE }, agent)).toMatchObject({ count: 0 });
    });

    it('an approver release is refused when the auth is not that approver, and runs when it is', async () => {
      routeFns.applyAnomalyStatus.mockResolvedValue({ status: 'ok', data: { id: ANOMALY } });
      expect(await run({ action: 'promote', deviceId: DEVICE, anomalyId: ANOMALY }, makeAuth(), { approverRelease: { approverUserId: 'someone-else' } }))
        .toMatchObject({ code: 'APPROVER_RELEASE_MISMATCH' });
      expect(routeFns.applyAnomalyStatus).not.toHaveBeenCalled();
      expect(await run({ action: 'promote', deviceId: DEVICE, anomalyId: ANOMALY }, makeAuth(), { approverRelease: { approverUserId: 'user-1' } }))
        .toEqual({ anomaly: { id: ANOMALY } });
    });
  });

  it('an unexpected throw is sanitized, not echoed', async () => {
    routeFns.queryDeviceAnomalies.mockRejectedValue(new Error('select "metric_anomalies" failed at db.internal'));
    const out = await run({ action: 'list', deviceId: DEVICE });
    expect(JSON.stringify(out)).not.toContain('db.internal');
    expect(out.error).toMatch(/Operation failed/);
  });
});
