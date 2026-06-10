/**
 * Phase 1 helper tool-action governance unit tests (security finding A).
 * Drizzle-mocked — covers verdict mapping, fail-safe, audit/events, and the
 * execution status bridge CAS.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  devices: { id: 'id', siteId: 'siteId', partnerId: 'partnerId' },
  elevationRequests: { id: 'id', status: 'status' },
  elevationAudit: { id: 'id' },
  pamRules: { id: 'id', orgId: 'orgId', siteId: 'siteId', enabled: 'enabled' },
  aiToolExecutions: { id: 'id', status: 'status' },
}));

const eventMocks = vi.hoisted(() => ({ publishEvent: vi.fn() }));
vi.mock('./eventBus', () => ({ publishEvent: eventMocks.publishEvent }));

import { createHash } from 'node:crypto';
import { db } from '../db';
import {
  decideHelperToolAction,
  mirrorElevationDecisionToExecution,
} from './pamToolActionGovernance';

const params = {
  orgId: 'org-1',
  deviceId: 'device-1',
  executionId: 'exec-1',
  toolName: 'manage_services',
  toolInput: { deviceId: 'device-1', action: 'restart', service: 'spooler' },
  riskTier: 2,
  subjectUsername: 'HOST-01',
};

/** A pam_rules row shaped like the engine expects. */
function toolRule(overrides: Record<string, unknown>) {
  return {
    id: 'rule-1',
    orgId: 'org-1',
    siteId: null,
    name: 'tool rule',
    description: null,
    enabled: true,
    priority: 100,
    matchSigner: null,
    matchHash: null,
    matchPathGlob: null,
    matchParentImage: null,
    matchUser: null,
    matchAdGroup: null,
    matchToolName: null,
    matchRiskTier: null,
    timeWindow: null,
    verdict: 'require_approval',
    approvalDurationMinutes: null,
    createdByUserId: null,
    createdAt: new Date('2026-06-01T00:00:00Z'),
    updatedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

/**
 * db.select chain serving BOTH shapes the service uses:
 *   device lookup:  .from().where().limit()  -> deviceRows
 *   pam_rules load: .from().where()  (awaited) -> ruleRows
 */
function mockSelects(
  deviceRows: Array<{ siteId: string | null; partnerId: string | null }>,
  ruleRows: unknown[] = [],
) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: vi.fn(() => ({
          where: vi.fn(() => {
            const thenable: any = Promise.resolve(ruleRows);
            thenable.limit = vi.fn().mockResolvedValue(deviceRows);
            return thenable;
          }),
        })),
      }) as any,
  );
}

/** Captures inserts; elevation insert returns `returning`, audit insert is awaited bare. */
function mockInserts(elevationId = 'elev-1') {
  const captured: Array<{ table: unknown; values: Record<string, unknown> }> = [];
  vi.mocked(db.insert).mockImplementation(
    (table: unknown) =>
      ({
        values: vi.fn((vals: Record<string, unknown>) => {
          captured.push({ table, values: vals });
          const thenable: any = Promise.resolve([]);
          thenable.returning = vi.fn().mockResolvedValue([{ id: elevationId }]);
          return thenable;
        }),
      }) as any,
  );
  return captured;
}

function mockUpdate(flippedRows: Array<{ id: string }>) {
  const where = vi.fn(() => ({ returning: vi.fn().mockResolvedValue(flippedRows) }));
  const set = vi.fn((_vals: Record<string, unknown>) => ({ where }));
  vi.mocked(db.update).mockReturnValue({ set } as any);
  return { set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('decideHelperToolAction', () => {
  it('auto_approve rule → auto_approved elevation, execution mirrored to approved, audit + events', async () => {
    mockSelects(
      [{ siteId: 'site-1', partnerId: 'partner-1' }],
      [toolRule({ matchToolName: 'manage_services', verdict: 'auto_approve' })],
    );
    const inserts = mockInserts();
    const { set } = mockUpdate([{ id: 'exec-1' }]);

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('auto_approved');

    const elevation = inserts[0]!.values;
    expect(elevation.flowType).toBe('ai_tool_action');
    expect(elevation.executionId).toBe('exec-1');
    expect(elevation.toolName).toBe('manage_services');
    expect(elevation.riskTier).toBe(2);
    expect(elevation.status).toBe('auto_approved');
    expect(elevation.approvedAt).toBeInstanceOf(Date);
    expect(elevation.expiresAt).toBeInstanceOf(Date);
    expect(elevation.orgId).toBe('org-1');
    expect(elevation.siteId).toBe('site-1');
    expect(elevation.subjectUserId).toBeNull();
    expect(elevation.actionDigest).toBe(
      createHash('sha256').update(JSON.stringify(params.toolInput)).digest('hex'),
    );

    // Audit: requested + auto_approved.
    const auditEvents = inserts.slice(1).map((i) => i.values.eventType);
    expect(auditEvents).toEqual(['requested', 'auto_approved']);

    // Mirror flipped the execution to approved.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: null }),
    );

    expect(eventMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.auto_approved',
      'org-1',
      expect.objectContaining({ flowType: 'ai_tool_action', executionId: 'exec-1' }),
      expect.any(String),
    );
  });

  it('auto_deny rule → denied elevation with denialReason, execution rejected', async () => {
    mockSelects(
      [{ siteId: null, partnerId: null }],
      [toolRule({ matchToolName: 'manage_services', verdict: 'auto_deny', name: 'no spooler' })],
    );
    const inserts = mockInserts();
    const { set } = mockUpdate([{ id: 'exec-1' }]);

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('denied');
    const elevation = inserts[0]!.values;
    expect(elevation.status).toBe('denied');
    expect(elevation.denialReason).toContain('no spooler');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'rejected' }));
    expect(eventMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.denied',
      'org-1',
      expect.anything(),
      expect.any(String),
    );
  });

  it('require_approval rule → pending elevation, execution untouched', async () => {
    mockSelects(
      [{ siteId: null, partnerId: null }],
      [toolRule({ matchToolName: 'manage_services', verdict: 'require_approval' })],
    );
    const inserts = mockInserts();
    mockUpdate([]);

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('pending');
    expect(inserts[0]!.values.status).toBe('pending');
    expect(db.update).not.toHaveBeenCalled();
    expect(eventMocks.publishEvent).toHaveBeenCalledWith(
      'elevation.requested',
      'org-1',
      expect.anything(),
      expect.any(String),
    );
  });

  it('no matching rule → pending (default posture)', async () => {
    mockSelects([{ siteId: null, partnerId: null }], []);
    const inserts = mockInserts();

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('pending');
    expect(inserts[0]!.values.status).toBe('pending');
  });

  it("'ignore' verdict → pending (no suppress semantics for tool actions)", async () => {
    mockSelects(
      [{ siteId: null, partnerId: null }],
      [toolRule({ matchToolName: 'manage_services', verdict: 'ignore' })],
    );
    const inserts = mockInserts();

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('pending');
    expect(inserts[0]!.values.status).toBe('pending');
  });

  it('a matchUser-only UAC rule never governs tool actions', async () => {
    mockSelects(
      [{ siteId: null, partnerId: null }],
      [toolRule({ matchUser: 'host-01', verdict: 'auto_approve' })],
    );
    const inserts = mockInserts();

    const decision = await decideHelperToolAction(params);

    expect(decision).toBe('pending');
    expect(inserts[0]!.values.status).toBe('pending');
  });

  it('decisioning error → fail-safe pending, never throws', async () => {
    vi.mocked(db.select).mockImplementation(() => {
      throw new Error('db down');
    });

    await expect(decideHelperToolAction(params)).resolves.toBe('pending');
  });

  it('audit insert failure does not flip a decided verdict', async () => {
    mockSelects(
      [{ siteId: null, partnerId: null }],
      [toolRule({ matchToolName: 'manage_services', verdict: 'auto_approve' })],
    );
    let call = 0;
    vi.mocked(db.insert).mockImplementation(
      () =>
        ({
          values: vi.fn(() => {
            call += 1;
            if (call === 1) {
              const thenable: any = Promise.resolve([]);
              thenable.returning = vi.fn().mockResolvedValue([{ id: 'elev-1' }]);
              return thenable;
            }
            return Promise.reject(new Error('audit down'));
          }),
        }) as any,
    );
    mockUpdate([{ id: 'exec-1' }]);

    await expect(decideHelperToolAction(params)).resolves.toBe('auto_approved');
  });
});

describe('mirrorElevationDecisionToExecution', () => {
  it('flips pending → approved with approvedBy', async () => {
    const { set } = mockUpdate([{ id: 'exec-1' }]);
    const flipped = await mirrorElevationDecisionToExecution(db, 'exec-1', true, 'user-9');
    expect(flipped).toBe(true);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved', approvedBy: 'user-9' }),
    );
    expect(set.mock.calls[0]?.[0]?.approvedAt).toBeInstanceOf(Date);
  });

  it('flips pending → rejected', async () => {
    const { set } = mockUpdate([{ id: 'exec-1' }]);
    const flipped = await mirrorElevationDecisionToExecution(db, 'exec-1', false, null);
    expect(flipped).toBe(true);
    expect(set).toHaveBeenCalledWith({ status: 'rejected' });
  });

  it('returns false when execution is not pending (CAS 0 rows)', async () => {
    mockUpdate([]);
    const flipped = await mirrorElevationDecisionToExecution(db, 'exec-1', true, 'user-9');
    expect(flipped).toBe(false);
  });
});
