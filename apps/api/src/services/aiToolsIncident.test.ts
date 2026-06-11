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

vi.mock('./commandQueue', () => ({
  queueCommandForExecution: vi.fn(),
}));

vi.mock('./eventBus', () => ({
  publishEvent: vi.fn(async () => undefined),
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
import { queueCommandForExecution } from './commandQueue';
import { registerIncidentTools } from './aiToolsIncident';

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
  vi.mocked(queueCommandForExecution).mockResolvedValue({ command: { id: 'cmd-1', status: 'queued' } } as any);
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
      expect(queueCommandForExecution).not.toHaveBeenCalled();
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
      expect(queueCommandForExecution).toHaveBeenCalledTimes(1);
      expect(JSON.parse(result).success).toBe(true);
    });
  }
});
