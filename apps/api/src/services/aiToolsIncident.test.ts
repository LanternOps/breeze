import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression guard for a cross-org device-dispatch hole (verified 2026-05-31):
 * `execute_containment` and `collect_evidence` validated only the incident's
 * org, then passed an attacker-controlled `input.deviceId` straight to
 * `queueCommandForExecution`, which resolves the device by id with NO tenant
 * filter. A user with an incident in their own org could therefore run
 * containment actions / forensic capture on ANY device in ANY org by id.
 *
 * The fix routes `input.deviceId` through the shared `verifyDeviceAccess`
 * gate (org-scoped) before dispatch — the same gate every sibling AI tool
 * uses. These tests assert the handler consults the gate and refuses to
 * dispatch when the device is not accessible.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./networkIsolation/service', () => ({ startNetworkIsolation: vi.fn() }));

vi.mock('./aiDispatch', () => ({
  aiQueueCommandForExecution: vi.fn(),
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn(async () => undefined),
}));

// QW8 (W04, #6758): screenshot evidence honours the screen-access consent gate.
vi.mock('../routes/remote/screenAccessConsentGate', () => ({
  checkScreenAccessConsentGate: vi.fn(async () => ({ ok: true })),
}));

// The device gate is a separately-tested collaborator
// (aiTools.verifyDeviceAccess.test.ts). Mock it so we can drive the
// accessible / not-accessible verdicts and assert the handler's control flow.
vi.mock('./aiTools', () => ({
  resolveWritableToolOrgId: vi.fn(() => ORG_ID),
  verifyDeviceAccess: vi.fn(),
}));

import { db } from '../db';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { verifyDeviceAccess } from './aiTools';
import { aiQueueCommandForExecution } from './aiDispatch';
import { registerIncidentTools } from './aiToolsIncident';
import { startNetworkIsolation } from './networkIsolation/service';
import { toolInputSchemas } from './aiToolSchemas';
import { checkScreenAccessConsentGate } from '../routes/remote/screenAccessConsentGate';

const ORG_ID = '11111111-1111-1111-1111-111111111111';
const INCIDENT_ID = '22222222-2222-2222-2222-222222222222';
const OWN_DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const FOREIGN_DEVICE_ID = '99999999-9999-9999-9999-999999999999';

function createQueryChain(rows: any[] = []) {
  const chain: any = {};
  chain.from = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.then = (resolve: (value: any[]) => unknown, reject?: (error: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return chain;
}

function createInsertChain(rows: any[] = []) {
  const chain: any = {};
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'test@example.com', name: 'Test User' },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    orgCondition: vi.fn(() => undefined),
    aiOrigin: { kind: 'ai_assistant', sessionId: 'test-session' },
  } as any;
}

function buildToolMap(): Map<string, AiTool> {
  const toolMap = new Map<string, AiTool>();
  registerIncidentTools(toolMap);
  return toolMap;
}

const INCIDENT_ROW = { id: INCIDENT_ID, orgId: ORG_ID, title: 'Test incident', severity: 'high', status: 'open' };

beforeEach(() => {
  vi.clearAllMocks();
  // findIncidentWithAccess() select returns the caller's own incident.
  vi.mocked(db.select).mockImplementation(() => createQueryChain([INCIDENT_ROW]) as any);
  vi.mocked(db.insert).mockImplementation(() => createInsertChain([{ id: 'action-1' }]) as any);
  vi.mocked(aiQueueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'queued' } } as any);
});

describe('incident AI tools — cross-org device gate', () => {
  const cases = [
    {
      tool: 'execute_containment',
      input: {
        incidentId: INCIDENT_ID,
        deviceId: FOREIGN_DEVICE_ID,
        actionType: 'process_kill',
        approvalRef: 'appr-1',
        parameters: { pid: 1234 },
      },
    },
    {
      tool: 'collect_evidence',
      input: {
        incidentId: INCIDENT_ID,
        deviceId: FOREIGN_DEVICE_ID,
        evidenceTypes: ['screenshot'],
      },
    },
  ] as const;

  for (const { tool, input } of cases) {
    it(`${tool} validates the target device against the caller's org`, async () => {
      vi.mocked(verifyDeviceAccess).mockResolvedValue({ error: 'Device not found or access denied' } as any);
      const toolMap = buildToolMap();

      const result = await toolMap.get(tool)!.handler(input as Record<string, unknown>, makeAuth());

      // The gate must be consulted with the user-supplied deviceId.
      expect(verifyDeviceAccess).toHaveBeenCalledWith(FOREIGN_DEVICE_ID, expect.anything());
      // And on denial, NO command may be dispatched to the foreign device.
      expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
      expect(JSON.parse(result).error).toMatch(/not found or access denied/i);
    });

    it(`${tool} dispatches when the device is accessible`, async () => {
      vi.mocked(verifyDeviceAccess).mockResolvedValue({
        device: { id: OWN_DEVICE_ID, orgId: ORG_ID, hostname: 'host-1', status: 'online' },
      } as any);
      const accessibleInput = { ...input, deviceId: OWN_DEVICE_ID };
      const toolMap = buildToolMap();

      const result = await toolMap.get(tool)!.handler(accessibleInput as Record<string, unknown>, makeAuth());

      expect(verifyDeviceAccess).toHaveBeenCalledWith(OWN_DEVICE_ID, expect.anything());
      expect(aiQueueCommandForExecution).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result).success).toBe(true);
    });
  }
});

/**
 * #9662: the action row is the containment's only lifecycle record, and the
 * agent-result handler finds it by command id. It must therefore exist (and
 * name the command id) BEFORE the command can reach the agent — a fast agent
 * answering before a post-dispatch insert left the row `in_progress` forever.
 */
describe('execute_containment action lifecycle (#9662)', () => {
  const input = {
    incidentId: INCIDENT_ID,
    deviceId: OWN_DEVICE_ID,
    actionType: 'process_kill',
    approvalRef: 'appr-1',
    parameters: { pid: 1234 },
  };

  function updateChain() {
    const chain: any = {};
    chain.set = vi.fn(() => chain);
    chain.where = vi.fn(() => Promise.resolve([]));
    return chain;
  }

  beforeEach(() => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({
      device: { id: OWN_DEVICE_ID, orgId: ORG_ID, hostname: 'host-1', status: 'online' },
    } as any);
  });

  it('records the action with a preallocated command id before dispatching that same id', async () => {
    const order: string[] = [];
    let insertedValues: any;
    vi.mocked(db.insert).mockImplementation(() => {
      const chain = createInsertChain([{ id: 'action-1' }]);
      chain.values = vi.fn((v: unknown) => { order.push('insert'); insertedValues = v; return chain; });
      return chain as any;
    });
    vi.mocked(aiQueueCommandForExecution).mockImplementation(async (...args: any[]) => {
      order.push('dispatch');
      return { command: { id: args[5].commandId, status: 'sent' } } as any;
    });

    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));

    expect(order).toEqual(['insert', 'dispatch']);
    const dispatchedId = vi.mocked(aiQueueCommandForExecution).mock.calls[0]![5]!.commandId;
    expect(dispatchedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(insertedValues).toMatchObject({ status: 'in_progress', result: { commandId: dispatchedId } });
    expect(out).toMatchObject({ success: true, commandId: dispatchedId, actionId: 'action-1' });
  });

  it('does not dispatch when the action cannot be recorded', async () => {
    vi.mocked(db.insert).mockImplementation(() => {
      const chain = createInsertChain([]);
      chain.returning = vi.fn(() => Promise.reject(new Error('insert failed')));
      return chain as any;
    });

    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));

    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    expect(out.error).toMatch(/could not be recorded/i);
  });

  it('fails the recorded action when the dispatch is refused', async () => {
    const chain = updateChain();
    vi.mocked(db.update).mockImplementation(() => chain);
    vi.mocked(aiQueueCommandForExecution).mockResolvedValue({ error: 'Device is offline' } as any);

    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));

    expect(out.error).toBe('Device is offline');
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      result: expect.objectContaining({ error: 'Device is offline' }),
    }));
  });

  it('cancels the recorded action when the dispatch was cancelled at claim time', async () => {
    const chain = updateChain();
    vi.mocked(db.update).mockImplementation(() => chain);
    vi.mocked(aiQueueCommandForExecution).mockResolvedValue({
      command: { id: 'cmd-1', status: 'cancelled' }, error: 'Command cancelled', refusal: 'cancelled',
    } as any);

    await buildToolMap().get('execute_containment')!.handler(input, makeAuth());

    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('refuses a device outside the incident organization', async () => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({
      device: { id: OWN_DEVICE_ID, orgId: '77777777-7777-7777-7777-777777777777', hostname: 'h', status: 'online' },
    } as any);

    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));

    expect(out.error).toMatch(/same organization/i);
    expect(db.insert).not.toHaveBeenCalled();
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });
});

/**
 * W04-D12 (#6758): collect_evidence must be bound to the incident's org, as
 * execute_containment is (#9662). Without it a multi-org caller could aim
 * forensic collection at a device in org B under an incident in org A.
 */
describe('collect_evidence device/incident org binding (W04-D12, #6758)', () => {
  const input = { incidentId: INCIDENT_ID, deviceId: OWN_DEVICE_ID, evidenceTypes: ['processes'] };

  it('refuses a device outside the incident organization and dispatches nothing', async () => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({
      device: { id: OWN_DEVICE_ID, orgId: '77777777-7777-7777-7777-777777777777', hostname: 'h', status: 'online' },
    } as any);

    const out = JSON.parse(await buildToolMap().get('collect_evidence')!.handler(input, makeAuth()));

    expect(out.error).toMatch(/same organization/i);
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });

  it('control: a device in the incident organization is dispatched', async () => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({
      device: { id: OWN_DEVICE_ID, orgId: ORG_ID, hostname: 'h', status: 'online' },
    } as any);

    const out = JSON.parse(await buildToolMap().get('collect_evidence')!.handler(input, makeAuth()));

    expect(out.success).toBe(true);
    expect(aiQueueCommandForExecution).toHaveBeenCalledTimes(1);
  });
});

/**
 * QW8 (W04 quorum, #6758): a screenshot is screen capture, so screenshot
 * evidence honours the device's remote-access consent policy exactly like
 * take_screenshot (checkScreenAccessConsentGate). Other evidence types are not
 * screen access and never consult it.
 */
describe('collect_evidence screenshot honours the screen-access consent gate (W04 QW8, #6758)', () => {
  const device = { id: OWN_DEVICE_ID, orgId: ORG_ID, hostname: 'host-1', status: 'online', isEphemeral: false };

  beforeEach(() => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({ device } as any);
  });

  it('refuses and dispatches nothing when the gate refuses a screenshot', async () => {
    vi.mocked(checkScreenAccessConsentGate).mockResolvedValueOnce({
      ok: false, status: 409, body: { error: 'consent required', code: 'CONSENT_REQUIRED' },
    } as any);

    const out = JSON.parse(await buildToolMap().get('collect_evidence')!.handler(
      { incidentId: INCIDENT_ID, deviceId: OWN_DEVICE_ID, evidenceTypes: ['processes', 'screenshot'] }, makeAuth(),
    ));

    expect(checkScreenAccessConsentGate).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: OWN_DEVICE_ID, orgId: ORG_ID, surface: 'collect_evidence',
    }));
    expect(out).toEqual({ error: 'consent required', code: 'CONSENT_REQUIRED' });
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });

  it('control: non-screenshot evidence never consults the gate', async () => {
    const out = JSON.parse(await buildToolMap().get('collect_evidence')!.handler(
      { incidentId: INCIDENT_ID, deviceId: OWN_DEVICE_ID, evidenceTypes: ['processes', 'connections'] }, makeAuth(),
    ));

    expect(checkScreenAccessConsentGate).not.toHaveBeenCalled();
    expect(out.success).toBe(true);
  });
});


describe('network isolation AI service ownership', () => {
  const isolationIncidentId = '22222222-2222-4222-8222-222222222222';
  const input = {
    incidentId: isolationIncidentId, deviceId: OWN_DEVICE_ID, actionType: 'network_isolation',
    approvalRef: 'appr-1', ttlHours: 24, reason: 'Contain incident',
    parameters: { allow: [{ scope: 'any', cidr: '192.0.2.0/24' }], generation: 99 },
  };
  beforeEach(() => {
    vi.mocked(verifyDeviceAccess).mockResolvedValue({ device: { id: OWN_DEVICE_ID, orgId: ORG_ID } } as any);
    vi.mocked(startNetworkIsolation).mockResolvedValue({ episode: { id: 'episode-1' }, commandId: 'isolation-command' } as any);
  });
  it('ignores caller parameters and delegates solely to the isolation service', async () => {
    const auth = makeAuth();
    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, auth));
    expect(startNetworkIsolation).toHaveBeenCalledWith(auth, OWN_DEVICE_ID,
      { incidentId: isolationIncidentId, ttlHours: 24, reason: 'Contain incident' },
      { requestedByKind: 'brain', approvalRef: 'appr-1' });
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(out).toMatchObject({ success: true, commandId: 'isolation-command' });
  });
  it.each([undefined, '', '   '])('asks for a reason when omitted or blank (%s)', async reason => {
    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler({ ...input, reason }, makeAuth()));
    expect(out.error).toMatch(/reason is required/i);
    expect(startNetworkIsolation).not.toHaveBeenCalled();
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });
  it.each(['feature_disabled', 'agent_below_gate', 'incident_mismatch', 'site_forbidden'] as const)(
    'returns the service refusal %s as a tool error', async error => {
      vi.mocked(startNetworkIsolation).mockResolvedValue({ error } as any);
      const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));
      expect(out).toMatchObject({ error });
      expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
    });
  it.each([0, 721, 1.5, '24'])('rejects invalid isolation TTL %s before starting', async ttlHours => {
    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler({ ...input, ttlHours }, makeAuth()));
    expect(out.error).toBe('Invalid isolation input: ttlHours');
    expect(startNetworkIsolation).not.toHaveBeenCalled();
    expect(aiQueueCommandForExecution).not.toHaveBeenCalled();
  });
  it('lists all invalid field paths without exposing raw Zod diagnostics', async () => {
    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler({
      ...input, incidentId: 'invalid', ttlHours: 0,
    }, makeAuth()));
    expect(out.error).toBe('Invalid isolation input: incidentId, ttlHours');
    expect(startNetworkIsolation).not.toHaveBeenCalled();
  });
  it('preserves the typed unsupported-agent refusal detail', async () => {
    vi.mocked(startNetworkIsolation).mockResolvedValue({ error: 'agent_not_ready', networkIsolationUnsupportedReason: 'mechanism_unavailable' });
    const out = JSON.parse(await buildToolMap().get('execute_containment')!.handler(input, makeAuth()));
    expect(out).toEqual({ error: 'agent_not_ready', networkIsolationUnsupportedReason: 'mechanism_unavailable' });
  });
  it('still requires approval and device access before the isolation service', async () => {
    const handler = buildToolMap().get('execute_containment')!.handler;
    expect(JSON.parse(await handler({ ...input, approvalRef: undefined }, makeAuth())).error).toMatch(/approvalRef/);
    expect(startNetworkIsolation).not.toHaveBeenCalled();
    vi.mocked(verifyDeviceAccess).mockResolvedValue({ error: 'Device not found or access denied' });
    expect(JSON.parse(await handler(input, makeAuth())).error).toMatch(/access denied/);
    expect(startNetworkIsolation).not.toHaveBeenCalled();
  });
  it('validates ttlHours and reason in the tool schema and advertises them', () => {
    const parsed = toolInputSchemas.execute_containment!.parse(input);
    expect(parsed).toMatchObject({ ttlHours: 24, reason: 'Contain incident' });
    expect(toolInputSchemas.execute_containment!.safeParse({ ...input, ttlHours: 721 }).success).toBe(false);
    expect(toolInputSchemas.execute_containment!.safeParse({ ...input, ttlHours: 0 }).success).toBe(false);
    const properties = buildToolMap().get('execute_containment')!.definition.input_schema.properties;
    expect(properties).toHaveProperty('ttlHours');
    expect(properties).toHaveProperty('reason');
  });
});
