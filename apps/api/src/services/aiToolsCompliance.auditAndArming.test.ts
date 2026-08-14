/**
 * #3543 — AI software-policy tools must write BOTH audit stores, and
 * remediate_software_violation must respect the policy's own uninstall arming.
 *
 * Context: incident #3381 (259 devices mass-uninstalled). The reporter's full
 * `audit_logs` trail contained no policy-arming event, because these tools wrote
 * to neither `audit_logs` nor `software_policy_audit`; and the remediation tool
 * refused only `mode === 'audit'`, so a detect-only policy could still have
 * fleet-wide uninstalls queued through the model.
 *
 * These assert on the actual audited VALUES (action names, actor, orgId, the
 * enforcement fields) rather than merely "an audit function was called".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/softwareComplianceWorker', () => ({ scheduleSoftwareComplianceCheck: vi.fn(async () => 'job-1') }));
vi.mock('../jobs/softwareRemediationWorker', () => ({ scheduleSoftwareRemediation: vi.fn(async () => 1) }));

// The two audit stores. `recordSoftwarePolicyAudit` (software_policy_audit) and
// `writeAuditEvent` (audit_logs) are spied at their real module boundaries so
// the shared aiToolsSoftwarePolicyAudit helper is exercised for real.
vi.mock('./softwarePolicyService', async (orig) => {
  const actual = await orig<typeof import('./softwarePolicyService')>();
  return {
    ...actual,
    normalizeSoftwarePolicyRules: vi.fn((r: any) => ({
      software: Array.isArray(r?.software) ? r.software : [],
      allowUnknown: r?.allowUnknown === true,
    })),
    recordSoftwarePolicyAudit: vi.fn(async () => {}),
  };
});
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { db } from '../db';
import { scheduleSoftwareRemediation } from '../jobs/softwareRemediationWorker';
import { recordSoftwarePolicyAudit } from './softwarePolicyService';
import { writeAuditEvent } from './auditEvents';
import { registerComplianceTools } from './aiToolsCompliance';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
};

const USER_ID = 'user-1';
const ORG_ID = 'org-1';
const POLICY_ID = 'pol-1';

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: USER_ID, email: 'ai@example.com', name: 'AI', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

/** Generic chainable query mock that resolves to `result`. */
function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'set', 'values', 'returning']) {
    p[m] = () => p;
  }
  return p;
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Blocklist policy',
    mode: 'blocklist',
    enforceMode: false,
    remediationOptions: null,
    isActive: true,
    rules: { software: [{ name: 'Foo' }], allowUnknown: false },
    ...overrides,
  };
}

const ARMED = { enforceMode: true, remediationOptions: { autoUninstall: true } };

function policyAuditCalls() {
  return vi.mocked(recordSoftwarePolicyAudit).mock.calls.map((c) => c[0]);
}
function auditLogCalls() {
  return vi.mocked(writeAuditEvent).mock.calls.map((c) => c[1]);
}

beforeEach(() => vi.clearAllMocks());

describe('manage_software_policy create — writes both audit stores (#3543)', () => {
  it('records policy_created + software_policy.create with the AI actor and the enforcement fields', async () => {
    const created = policyRow({ ...ARMED, name: 'Armed policy' });
    mockDb.insert.mockImplementation(() => chain([created]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Armed policy',
      mode: 'blocklist',
      software: [{ name: 'Foo' }],
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeAuth()));

    expect(result.success).toBe(true);

    const [policyAudit] = policyAuditCalls();
    expect(policyAudit).toMatchObject({
      orgId: ORG_ID,
      partnerId: null,
      policyId: POLICY_ID,
      action: 'policy_created',
      actor: 'ai',
      actorId: USER_ID,
    });
    // The arming decision must be legible in the trail, not just "something changed".
    expect(policyAudit!.details).toMatchObject({
      mode: 'blocklist',
      enforceMode: true,
      autoUninstall: true,
      toolName: 'manage_software_policy',
    });

    const [auditLog] = auditLogCalls();
    expect(auditLog).toMatchObject({
      orgId: ORG_ID,
      actorId: USER_ID,
      actorEmail: 'ai@example.com',
      action: 'software_policy.create',
      resourceType: 'software_policy',
      resourceId: POLICY_ID,
      result: 'success',
    });
    expect(auditLog!.details).toMatchObject({ enforceMode: true, autoUninstall: true, tool_name: 'manage_software_policy' });
  });

  it('does not audit when the create is rejected before any row is written', async () => {
    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'No rules',
      mode: 'blocklist',
      software: [],
    }, makeAuth()));

    expect(result.error).toBeTruthy();
    expect(recordSoftwarePolicyAudit).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('manage_software_policy update — writes both audit stores (#3543)', () => {
  it('flags an enforceMode arming change explicitly and lists only persisted fields', async () => {
    const existing = policyRow();
    mockDb.select.mockImplementation(() => chain([existing]));
    mockDb.update.mockImplementation(() => chain([{ ...existing, ...ARMED }]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeAuth()));

    expect(result.success).toBe(true);

    const [policyAudit] = policyAuditCalls();
    expect(policyAudit).toMatchObject({
      orgId: ORG_ID,
      policyId: POLICY_ID,
      action: 'policy_updated',
      actor: 'ai',
      actorId: USER_ID,
    });
    expect(policyAudit!.details).toMatchObject({ enforceMode: true, autoUninstall: true });
    // `updatedFields` is derived from the columns written, so the routing keys
    // `action`/`policyId` (present in `input`) must NOT appear.
    const updatedFields = (policyAudit!.details as any).updatedFields as string[];
    expect(updatedFields).toEqual(expect.arrayContaining(['enforceMode', 'remediationOptions']));
    expect(updatedFields).not.toContain('action');
    expect(updatedFields).not.toContain('policyId');
    expect(updatedFields).not.toContain('updatedAt');

    const [auditLog] = auditLogCalls();
    expect(auditLog).toMatchObject({ action: 'software_policy.update', resourceId: POLICY_ID, actorId: USER_ID });
  });

  it('does not audit when the policy is not visible to the caller', async () => {
    mockDb.select.mockImplementation(() => chain([]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update', policyId: POLICY_ID, enforceMode: true,
    }, makeAuth()));

    expect(result.error).toMatch(/not found or access denied/i);
    expect(recordSoftwarePolicyAudit).not.toHaveBeenCalled();
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});

describe('manage_software_policy delete — writes both audit stores (#3543)', () => {
  it('records policy_deleted + software_policy.delete', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow()]));
    mockDb.transaction.mockImplementation(async (fn: any) =>
      fn({ update: () => chain([]), delete: () => chain([]) }));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'delete', policyId: POLICY_ID,
    }, makeAuth()));

    expect(result.success).toBe(true);
    expect(policyAuditCalls()[0]).toMatchObject({ action: 'policy_deleted', actor: 'ai', actorId: USER_ID, policyId: POLICY_ID });
    expect(auditLogCalls()[0]).toMatchObject({ action: 'software_policy.delete', resourceId: POLICY_ID });
  });
});

describe('remediate_software_violation — arming gate (#3543 / incident #3381)', () => {
  it('refuses a detect-only policy (enforceMode false) and queues NOTHING', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: false })]));

    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: POLICY_ID, deviceIds: ['d1', 'd2'],
    }, makeAuth()));

    expect(result.error).toMatch(/enforceMode=false/);
    expect(result.reason).toBe('enforce_mode_off');
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('refuses when enforceMode is on but autoUninstall is not armed', async () => {
    mockDb.select.mockImplementation(() => chain([
      policyRow({ enforceMode: true, remediationOptions: { autoUninstall: false, notifyUser: true } }),
    ]));

    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: POLICY_ID, deviceIds: ['d1'],
    }, makeAuth()));

    expect(result.reason).toBe('auto_uninstall_off');
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('refuses when remediationOptions is null (arming is opt-in, never inferred)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: true, remediationOptions: null })]));

    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: POLICY_ID, deviceIds: ['d1'],
    }, makeAuth()));

    expect(result.reason).toBe('auto_uninstall_off');
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('still refuses an audit-mode policy, reported as audit_mode', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ mode: 'audit', ...ARMED })]));

    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: POLICY_ID, deviceIds: ['d1'],
    }, makeAuth()));

    expect(result.reason).toBe('audit_mode');
    expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
  });

  it('audits the refusal to both stores as a denied remediation', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: false })]));

    await handlerFor('remediate_software_violation')({ policyId: POLICY_ID, deviceIds: ['d1', 'd2'] }, makeAuth());

    expect(policyAuditCalls()[0]).toMatchObject({
      policyId: POLICY_ID,
      action: 'remediation_denied',
      actor: 'ai',
      actorId: USER_ID,
    });
    expect(policyAuditCalls()[0]!.details).toMatchObject({ reason: 'enforce_mode_off', requestedDeviceCount: 2 });
    expect(auditLogCalls()[0]).toMatchObject({
      action: 'software_policy.remediate',
      resourceId: POLICY_ID,
      result: 'denied',
    });
  });

  it('there is no override input that re-enables an unarmed policy', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: false })]));

    for (const override of [
      { force: true },
      { enforceMode: true },
      { autoUninstall: true },
      { remediationOptions: { autoUninstall: true } },
      { override: true },
    ]) {
      vi.mocked(scheduleSoftwareRemediation).mockClear();
      const result = JSON.parse(await handlerFor('remediate_software_violation')({
        policyId: POLICY_ID, deviceIds: ['d1'], ...override,
      }, makeAuth()));
      expect(result.error, `override ${JSON.stringify(override)} must not be honoured`).toBeTruthy();
      expect(scheduleSoftwareRemediation).not.toHaveBeenCalled();
    }
  });

  it('an armed policy still remediates and audits remediation_requested', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow(ARMED)]));
    vi.mocked(scheduleSoftwareRemediation).mockResolvedValue(2);

    const result = JSON.parse(await handlerFor('remediate_software_violation')({
      policyId: POLICY_ID, deviceIds: ['d1', 'd2'],
    }, makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.queued).toBe(2);
    expect(scheduleSoftwareRemediation).toHaveBeenCalledWith(POLICY_ID, ['d1', 'd2']);

    expect(policyAuditCalls()[0]).toMatchObject({
      policyId: POLICY_ID,
      action: 'remediation_requested',
      actor: 'ai',
      actorId: USER_ID,
    });
    expect(policyAuditCalls()[0]!.details).toMatchObject({ requestedCount: 2, queued: 2 });
    expect(auditLogCalls()[0]).toMatchObject({ action: 'software_policy.remediate', result: 'success' });
  });

  it('the AI path never requests the manual override trigger', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow(ARMED)]));
    vi.mocked(scheduleSoftwareRemediation).mockResolvedValue(1);

    await handlerFor('remediate_software_violation')({ policyId: POLICY_ID, deviceIds: ['d1'] }, makeAuth());

    const options = vi.mocked(scheduleSoftwareRemediation).mock.calls[0]![2];
    expect(options?.trigger).not.toBe('manual');
  });
});
