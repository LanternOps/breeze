/**
 * Contract-A D4 (#5505 W05): the AI may never arm
 * `remediationOptions.autoInstall` via `manage_software_policy`
 * (aiToolsCompliance.ts). An `autoInstall: true` reaching either write site
 * must be REFUSED outright, not silently stripped.
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
  };
});
vi.mock('./auditEvents', () => ({
  writeAuditEvent: vi.fn(),
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
}));

import { db } from '../db';
import { registerComplianceTools } from './aiToolsCompliance';
import { AI_AUTO_INSTALL_REFUSAL_MESSAGE } from './aiToolsSoftwarePolicyAudit';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
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

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'where', 'orderBy', 'limit', 'set', 'values', 'returning']) {
    p[m] = () => p;
  }
  return p;
}

function policyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Allowlist policy',
    mode: 'allowlist',
    enforceMode: false,
    remediationOptions: null,
    isActive: true,
    rules: { software: [{ name: 'Foo' }], allowUnknown: false },
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('manage_software_policy create — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } with the exact contract message and writes nothing', async () => {
    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Armed policy',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      enforceMode: true,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('still allows autoUninstall arming (unrelated, unchanged verb) when autoInstall is absent', async () => {
    mockDb.insert.mockImplementation(() =>
      chain([policyRow({ enforceMode: true, remediationOptions: { autoUninstall: true } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Armed for uninstall',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      enforceMode: true,
      remediationOptions: { autoUninstall: true },
    }, makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it('allows autoInstall: false (an explicit opt-out is not an arm attempt)', async () => {
    mockDb.insert.mockImplementation(() => chain([policyRow({ remediationOptions: { autoInstall: false } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'Not armed',
      mode: 'allowlist',
      software: [{ name: 'Foo' }],
      remediationOptions: { autoInstall: false },
    }, makeAuth()));

    expect(result.error).toBeUndefined();
  });
});

describe('manage_software_policy update — autoInstall refusal (contract-A D4)', () => {
  it('refuses { autoInstall: true } on an existing policy and writes nothing', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow()]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('refuses regardless of the policy\'s current enforcement state (this is a write-time refusal, not an arming check)', async () => {
    mockDb.select.mockImplementation(() => chain([policyRow({ mode: 'audit', enforceMode: false })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      remediationOptions: { autoInstall: true },
    }, makeAuth()));

    expect(result.error).toBe(AI_AUTO_INSTALL_REFUSAL_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('manage_software_policy get — reads are never gated (decision: AI may read armed state, never write it)', () => {
  it('returns a policy whose autoInstall is already armed (by a human, via HTTP) without refusing', async () => {
    mockDb.select.mockImplementation(() =>
      chain([policyRow({ enforceMode: true, remediationOptions: { autoInstall: true } })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'get',
      policyId: POLICY_ID,
    }, makeAuth()));

    expect(result.error).toBeUndefined();
    expect(result.policy.remediationOptions.autoInstall).toBe(true);
  });
});
