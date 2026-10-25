/**
 * W04-D15 + QW10: manage_software_policy must (a) revoke PAM elevations minted
 * by a policy when it is deactivated/deleted, exactly like the REST routes,
 * inside the same transaction as the write; (b) refuse any update whose
 * RESULTING state is install-armed (the AI never re-approves an armed policy).
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
vi.mock('./softwarePolicyService', async (orig) => {
  const actual = await orig<typeof import('./softwarePolicyService')>();
  return {
    ...actual,
    normalizeSoftwarePolicyRules: vi.fn((r: any) => ({
      software: Array.isArray(r?.software) ? r.software : [],
      allowUnknown: r?.allowUnknown === true,
    })),
    recordSoftwarePolicyAudit: vi.fn(async () => {}),
    cleanupSoftwarePolicyElevations: vi.fn(async () => 0),
  };
});
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { db } from '../db';
import { registerComplianceTools } from './aiToolsCompliance';
import { cleanupSoftwarePolicyElevations } from './softwarePolicyService';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as Record<'select' | 'insert' | 'update' | 'transaction', ReturnType<typeof vi.fn>>;
const cleanup = cleanupSoftwarePolicyElevations as unknown as ReturnType<typeof vi.fn>;

const ORG_ID = 'org-1';
const POLICY_ID = 'pol-1';
let txWrites: string[];

function handler(): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerComplianceTools(reg);
  return reg.get('manage_software_policy')!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'user-1', email: 'ai@example.com', name: 'AI', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: ORG_ID,
    scope: 'organization',
    accessibleOrgIds: [ORG_ID],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
  } as unknown as AuthContext;
}

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning']) p[m] = () => p;
  return p;
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID, orgId: ORG_ID, partnerId: null, name: 'P', mode: 'allowlist',
    enforceMode: false, remediationOptions: null, isActive: true,
    rules: { software: [{ name: 'Foo' }], allowUnknown: false },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  txWrites = [];
  const tx = {
    update: vi.fn(() => { txWrites.push('update'); return chain([policyRow()]); }),
    delete: vi.fn(() => { txWrites.push('delete'); return chain([]); }),
  };
  mockDb.transaction.mockImplementation(async (fn: any) => fn(tx));
  cleanup.mockImplementation(async (t: unknown) => { expect(t).toBe(tx); txWrites.push('cleanup'); return 0; });
});

describe('manage_software_policy update — PAM elevation cleanup (W04-D15)', () => {
  it('deactivation revokes the policy elevations inside the write transaction', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ isActive: true })]));
    const result = JSON.parse(await handler()({ action: 'update', policyId: POLICY_ID, isActive: false }, makeAuth()));
    expect(result.success).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]![1]).toBe(POLICY_ID);
    expect(txWrites).toEqual(['update', 'cleanup']);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('a non-deactivating update does not call cleanup', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ isActive: true })]));
    const result = JSON.parse(await handler()({ action: 'update', policyId: POLICY_ID, name: 'Renamed' }, makeAuth()));
    expect(result.success).toBe(true);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('isActive:false on an already-inactive policy does not call cleanup (REST parity)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ isActive: false })]));
    await handler()({ action: 'update', policyId: POLICY_ID, isActive: false }, makeAuth());
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('delete revokes the policy elevations inside the transaction', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow()]));
    const result = JSON.parse(await handler()({ action: 'delete', policyId: POLICY_ID }, makeAuth()));
    expect(result.success).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup.mock.calls[0]![1]).toBe(POLICY_ID);
    expect(txWrites).toEqual(['update', 'cleanup', 'delete']);
  });
});

describe('manage_software_policy update — merged-state install gate (QW10)', () => {
  const armed = { enforceMode: true, remediationOptions: { autoInstall: true } };

  it('refuses an update that omits remediationOptions on an install-armed policy; nothing written', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow(armed)]));
    const result = JSON.parse(await handler()({ action: 'update', policyId: POLICY_ID, name: 'Renamed' }, makeAuth()));
    expect(result.error).toMatch(/armed for automatic install/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('refuses when the update itself turns enforceMode on over stored autoInstall', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: false, remediationOptions: { autoInstall: true } })]));
    const result = JSON.parse(await handler()({ action: 'update', policyId: POLICY_ID, enforceMode: true }, makeAuth()));
    expect(result.error).toMatch(/armed for automatic install/);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('allows an update that disarms install (REST allows disarming)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow(armed)]));
    const result = JSON.parse(await handler()({
      action: 'update', policyId: POLICY_ID, remediationOptions: { autoInstall: false },
    }, makeAuth()));
    expect(result.success).toBe(true);
  });

  it('allows updating a stored autoInstall policy that is not effectively armed (enforceMode off)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ enforceMode: false, remediationOptions: { autoInstall: true } })]));
    const result = JSON.parse(await handler()({ action: 'update', policyId: POLICY_ID, name: 'x' }, makeAuth()));
    expect(result.success).toBe(true);
  });
});
