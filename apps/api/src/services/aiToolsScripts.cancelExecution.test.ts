import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #3525 W02b — the `cancel_script_execution` tier-3 tool.
 *
 * The state machine itself is covered by scriptCancellation.request.test.ts;
 * what is unique here is the TENANCY gate. The tool takes only an execution id,
 * so nothing in the input names a device and the central `enforceDeviceArgs`
 * hook cannot help — the handler has to scope the execution by org and then run
 * the device through the same `verifyDeviceAccess` the write path uses, or a
 * bare uuid would stop another tenant's script.
 */

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

const cancelScriptExecutionMock = vi.hoisted(() => vi.fn());
const deliverCancelCommandMock = vi.hoisted(() => vi.fn());
vi.mock('./scriptCancellation', () => ({
  cancelScriptExecution: cancelScriptExecutionMock,
  deliverCancelCommand: deliverCancelCommandMock,
}));

import { eq } from 'drizzle-orm';
import { db } from '../db';
import { scriptExecutions } from '../db/schema';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const EXECUTION_ID = '11111111-1111-1111-1111-111111111111';
const DEVICE_ID = '33333333-3333-3333-3333-333333333333';
const SITE_ID = '44444444-4444-4444-4444-444444444444';

function getTool(): AiTool {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map.get('cancel_script_execution')!;
}

function makeAuth(overrides: {
  canAccessSite?: (siteId: string | null) => boolean;
  orgCondition?: (col: unknown) => unknown;
} = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'tech@msp.example', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: overrides.orgCondition ?? (() => undefined),
    canAccessOrg: () => true,
    canAccessSite: overrides.canAccessSite ?? (() => true),
  } as unknown as AuthContext;
}

/**
 * Two sequential `db.select` calls: the execution lookup, then
 * `verifyDeviceAccess`'s device lookup. Returning `[]` from either models
 * "outside this caller's tenancy".
 */
function mockLookups(options: {
  executionRows?: unknown[];
  deviceRows?: unknown[];
  captured?: unknown[];
}) {
  const { executionRows = [{ id: EXECUTION_ID, deviceId: DEVICE_ID }], deviceRows, captured } = options;
  const rowsInOrder = [
    executionRows,
    deviceRows ?? [{ id: DEVICE_ID, orgId: 'org-1', siteId: SITE_ID, status: 'online', hostname: 'dev1' }],
  ];
  let call = 0;
  (db.select as ReturnType<typeof vi.fn>).mockImplementation(() => ({
    from: () => ({
      where: (cond: unknown) => {
        const rows = rowsInOrder[call++] ?? [];
        captured?.push(cond);
        return { limit: () => Promise.resolve(rows) };
      },
    }),
  }));
}

/** Flatten a drizzle condition tree to lowercase tokens (see getExecution test). */
function flattenSql(node: unknown, out: string[] = []): string[] {
  if (node == null) return out;
  const anyNode = node as Record<string, unknown>;
  if (Array.isArray(node)) {
    for (const child of node) flattenSql(child, out);
  } else if (Array.isArray(anyNode.queryChunks)) {
    flattenSql(anyNode.queryChunks, out);
  } else if (Array.isArray(anyNode.value)) {
    for (const v of anyNode.value) out.push(String(v).toLowerCase());
  } else if (typeof anyNode.name === 'string') {
    out.push(String(anyNode.name).toLowerCase());
  } else if ('value' in anyNode) {
    out.push(String(anyNode.value).toLowerCase());
  }
  return out;
}
const sqlTokenText = (node: unknown) => flattenSql(node).join('|');

beforeEach(() => {
  vi.clearAllMocks();
  deliverCancelCommandMock.mockResolvedValue(true);
  cancelScriptExecutionMock.mockResolvedValue({
    kind: 'cancelling',
    executionId: EXECUTION_ID,
    cancelCommandId: 'cancel-cmd-1',
    deviceId: DEVICE_ID,
    alreadyQueued: false,
  });
});

describe('cancel_script_execution', () => {
  it('is registered at tier 3, the same gate as run_script', () => {
    const tool = getTool();
    expect(tool.tier).toBe(3);
    // No device-id property in the schema, so nothing for the central gate to
    // enforce — the handler does it inline instead.
    expect(tool.deviceArgs).toEqual([]);
    expect(tool.definition.input_schema.required).toEqual(['executionId']);
  });

  it('binds the requested execution id and applies the caller org condition', async () => {
    const captured: unknown[] = [];
    mockLookups({ captured });
    const auth = makeAuth({ orgCondition: (col) => eq(col as Parameters<typeof eq>[0], 'org-1') });

    await getTool().handler({ executionId: EXECUTION_ID }, auth);

    // Without both predicates a bare uuid reaches the state machine, which is
    // authorization-free by design and would happily stop another tenant's run.
    expect(sqlTokenText(captured[0])).toContain(sqlTokenText(eq(scriptExecutions.id, EXECUTION_ID)));
    expect(sqlTokenText(captured[0])).toContain(sqlTokenText(eq(scriptExecutions.orgId, 'org-1')));
  });

  it('refuses an execution the caller cannot see, without touching the service', async () => {
    mockLookups({ executionRows: [] });
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));

    expect(result.error).toBe('Execution not found or access denied');
    expect(cancelScriptExecutionMock).not.toHaveBeenCalled();
  });

  it('refuses when the device is outside the caller site allowlist', async () => {
    mockLookups({});
    const auth = makeAuth({ canAccessSite: (siteId) => siteId !== SITE_ID });
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, auth));

    expect(result.error).toBe('Device not found or access denied');
    expect(cancelScriptExecutionMock).not.toHaveBeenCalled();
  });

  it('delegates to the shared service and delivers the queued cancel', async () => {
    mockLookups({});
    const result = JSON.parse(await getTool().handler(
      { executionId: EXECUTION_ID, graceSeconds: 10 },
      makeAuth(),
    ));

    expect(cancelScriptExecutionMock).toHaveBeenCalledWith(expect.objectContaining({
      executionId: EXECUTION_ID,
      actorId: 'u1',
      graceSeconds: 10,
    }));
    expect(deliverCancelCommandMock).toHaveBeenCalledWith('cancel-cmd-1', DEVICE_ID);
    expect(result).toMatchObject({ executionId: EXECUTION_ID, outcome: 'cancelling' });
  });

  it('does not re-deliver a cancel that was already in flight', async () => {
    mockLookups({});
    cancelScriptExecutionMock.mockResolvedValue({
      kind: 'cancelling',
      executionId: EXECUTION_ID,
      cancelCommandId: 'cancel-cmd-existing',
      deviceId: DEVICE_ID,
      alreadyQueued: true,
    });

    await getTool().handler({ executionId: EXECUTION_ID }, makeAuth());
    expect(deliverCancelCommandMock).not.toHaveBeenCalled();
  });

  it('spells out that a "recovered" outcome means the cancel was too late', async () => {
    // Of the seven outcome kinds this is the one whose bare name points the
    // WRONG way to a model — "recovered" reads as "successfully resolved" when
    // it means the script finished on its own and the cancel did nothing.
    mockLookups({});
    cancelScriptExecutionMock.mockResolvedValue({
      kind: 'recovered', executionId: EXECUTION_ID, commandId: 'cmd-1',
    });

    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));
    expect(result.outcome).toBe('recovered');
    expect(result.detail).toMatch(/TOO LATE/);
    expect(result.detail).toMatch(/no effect/);
    expect(deliverCancelCommandMock).not.toHaveBeenCalled();
  });

  it('never describes a queued cancel as a completed stop', async () => {
    mockLookups({});
    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));
    expect(result.outcome).toBe('cancelling');
    expect(result.detail).toMatch(/NOT stopped yet/);
  });

  it('reports a terminal execution honestly rather than claiming a stop', async () => {
    mockLookups({});
    cancelScriptExecutionMock.mockResolvedValue({ kind: 'already_terminal', status: 'completed' });

    const result = JSON.parse(await getTool().handler({ executionId: EXECUTION_ID }, makeAuth()));
    expect(result).toMatchObject({
      executionId: EXECUTION_ID, outcome: 'already_terminal', status: 'completed',
    });
    expect(result.detail).toMatch(/nothing was cancelled/);
    expect(deliverCancelCommandMock).not.toHaveBeenCalled();
  });
});
