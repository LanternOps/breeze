import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SPIKE demonstration: the declarative gate retroactively closes the cross-org
 * incident-tool hole (execute_containment / collect_evidence) with NOTHING but
 * a `deviceArgs: ['deviceId']` declaration — no change to the handler body.
 *
 * On this branch the incident handlers still validate only the incident's org
 * and pass `input.deviceId` straight to queueCommandForExecution. Declaring the
 * device arg makes the central dispatch gate (`enforceDeviceArgs`, run by
 * `executeTool`) reject an out-of-tenant device before the handler runs.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

import { db } from '../db';
import { enforceDeviceArgs } from './aiTools';
import type { AiTool } from './aiTools';
import { registerIncidentTools } from './aiToolsIncident';
import type { AuthContext } from '../middleware/auth';

const FOREIGN_DEVICE = '99999999-9999-9999-9999-999999999999';
const OWN_DEVICE = '33333333-3333-3333-3333-333333333333';

function deviceLookup(rows: any[]) {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
    }),
  } as any;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'u@example.com', name: 'U' },
    token: {} as any,
    partnerId: null,
    orgId: 'org-123',
    scope: 'organization',
    accessibleOrgIds: ['org-123'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as any;
}

function incidentTools(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerIncidentTools(map);
  return map;
}

beforeEach(() => vi.clearAllMocks());

describe('incident tools are closed by the declarative gate', () => {
  it.each(['execute_containment', 'collect_evidence'])(
    '%s declares its device arg',
    (name) => {
      expect(incidentTools().get(name)!.deviceArgs).toEqual(['deviceId']);
    },
  );

  it.each(['execute_containment', 'collect_evidence'])(
    'gate denies %s a device outside the caller org/site',
    async (name) => {
      vi.mocked(db.select).mockImplementation(() => deviceLookup([]) as any); // org/site filter excludes it
      const tool = incidentTools().get(name)!;

      const gateError = await enforceDeviceArgs(tool, { deviceId: FOREIGN_DEVICE }, makeAuth());

      expect(gateError).not.toBeNull();
      expect(JSON.parse(gateError!).error).toMatch(/not found or access denied/i);
    },
  );

  it.each(['execute_containment', 'collect_evidence'])(
    'gate allows %s an accessible device',
    async (name) => {
      vi.mocked(db.select).mockImplementation(
        () => deviceLookup([{ id: OWN_DEVICE, hostname: 'h', siteId: 's', status: 'online' }]) as any,
      );
      const tool = incidentTools().get(name)!;

      expect(await enforceDeviceArgs(tool, { deviceId: OWN_DEVICE }, makeAuth())).toBeNull();
    },
  );
});
