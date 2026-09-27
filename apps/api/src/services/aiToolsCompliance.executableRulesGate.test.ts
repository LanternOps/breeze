/**
 * #5480 moved PAM approval/policy authority to pam:approve / pam:manage_policy.
 * routes/softwarePolicies.ts gates rules.executable[] mode-switches on
 * pam.manage_policy. manage_software_policy (also served via MCP, same tool
 * registry) writes softwarePolicies directly, so it applies the same gate:
 * switching an audit-mode policy that already carries rules.executable[]
 * into allowlist/blocklist feeds the PAM auto-approve/auto-deny bridge and
 * requires pam.manage_policy, exactly as on the HTTP path.
 *
 * This suite exercises the gate through the AI tool handler directly
 * (mocked db/permissions), mirroring
 * routes/softwarePolicies.executableRulesGate.test.ts.
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
vi.mock('./aiToolsSoftwarePolicyAudit', () => ({
  auditSoftwarePolicyToolEvent: vi.fn(),
  summarizeEnforcementChange: vi.fn(() => ({})),
  remediationOptionsArmsAutoInstall: vi.fn(() => false),
  AI_AUTO_INSTALL_REFUSAL_MESSAGE: 'AI_AUTO_INSTALL_REFUSAL_MESSAGE (mocked)',
}));

const { mfaRef, managePolicyRef, permsRef } = vi.hoisted(() => ({
  mfaRef: { current: true },
  managePolicyRef: { current: true },
  permsRef: { current: {} as Record<string, unknown> | null },
}));

vi.mock('../middleware/auth', async (orig) => {
  const actual = await orig<typeof import('../middleware/auth')>();
  return {
    ...actual,
    hasSatisfiedMfa: vi.fn(() => mfaRef.current),
  };
});

vi.mock('./permissions', async (orig) => {
  const actual = await orig<typeof import('./permissions')>();
  return {
    ...actual,
    getUserPermissions: vi.fn(async () => permsRef.current),
    hasPermission: vi.fn((_perms: unknown, resource: string, action: string) => {
      if (resource === 'pam' && action === 'manage_policy') return managePolicyRef.current;
      return true;
    }),
  };
});

import { db } from '../db';
import { registerComplianceTools } from './aiToolsCompliance';
import { EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE } from './softwarePolicyExecutableRulesAuthorization';
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

/** An autonomous ai_agent run, attributed via a synthetic principal id. */
function makeAgentAuth(): AuthContext {
  return {
    ...makeAuth(),
    principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
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

/** An audit-mode policy that already carries executable[] rules — set earlier
 *  through the HTTP route by a properly authorized pam.manage_policy holder. */
function governedPolicyRow(overrides: Record<string, unknown> = {}) {
  return {
    id: POLICY_ID,
    orgId: ORG_ID,
    partnerId: null,
    name: 'Governed policy',
    mode: 'audit',
    enforceMode: false,
    remediationOptions: null,
    isActive: true,
    rules: { software: [], executable: [{ sha256: 'a'.repeat(64) }] },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mfaRef.current = true;
  managePolicyRef.current = true;
  permsRef.current = { permissions: [], scope: 'organization', orgId: ORG_ID, partnerId: null, roleId: 'role-1' };
});

describe('manage_software_policy update — PAM executable-rules gate', () => {
  it('refuses a mode switch on a policy carrying executable[] when the caller lacks pam.manage_policy', async () => {
    managePolicyRef.current = false;
    mockDb.select.mockImplementation(() => chain([governedPolicyRow()]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      mode: 'blocklist',
    }, makeAuth()));

    expect(result.error).toBe(EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('refuses the same mode switch when the caller has pam.manage_policy but has not satisfied MFA', async () => {
    mfaRef.current = false;
    mockDb.select.mockImplementation(() => chain([governedPolicyRow()]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      mode: 'allowlist',
    }, makeAuth()));

    expect(result.error).toBeTruthy();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('allows the mode switch when the caller has pam.manage_policy and satisfied MFA', async () => {
    const existing = governedPolicyRow();
    mockDb.select.mockImplementation(() => chain([existing]));
    mockDb.update.mockImplementation(() => chain([{ ...existing, mode: 'blocklist' }]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      mode: 'blocklist',
    }, makeAuth()));

    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('does not gate an update that leaves mode and executable[] untouched', async () => {
    const existing = governedPolicyRow();
    mockDb.select.mockImplementation(() => chain([existing]));
    mockDb.update.mockImplementation(() => chain([{ ...existing, name: 'Renamed' }]));
    managePolicyRef.current = false;

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      name: 'Renamed',
    }, makeAuth()));

    expect(result.success).toBe(true);
    expect(mockDb.update).toHaveBeenCalled();
  });

  it('does not gate a mode switch on a policy with no executable[] rules', async () => {
    const existing = governedPolicyRow({ rules: { software: [{ name: 'Foo' }], executable: [] } });
    mockDb.select.mockImplementation(() => chain([existing]));
    mockDb.update.mockImplementation(() => chain([{ ...existing, mode: 'blocklist' }]));
    managePolicyRef.current = false;

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      mode: 'blocklist',
    }, makeAuth()));

    expect(result.success).toBe(true);
  });
});

describe('manage_software_policy update — ai_agent principal', () => {
  it('refuses an autonomous ai_agent caller even when the permissions lookup would otherwise allow it', async () => {
    // Simulate the coincidental case where getUserPermissions does NOT miss
    // on the agent's synthetic principal id (e.g. a future membership-lookup
    // change) — the gate must still refuse on principal kind alone, not rely
    // on the lookup failing.
    mockDb.select.mockImplementation(() => chain([governedPolicyRow()]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'update',
      policyId: POLICY_ID,
      mode: 'blocklist',
    }, makeAgentAuth()));

    expect(result.error).toBe(EXECUTABLE_RULES_MANAGE_POLICY_DENIED_MESSAGE);
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

describe('manage_software_policy create — PAM executable-rules gate', () => {
  it('is unaffected: the create schema exposes no executable field, so the gate never fires', async () => {
    managePolicyRef.current = false;
    mockDb.insert.mockImplementation(() => chain([governedPolicyRow({ mode: 'blocklist' })]));

    const result = JSON.parse(await handlerFor('manage_software_policy')({
      action: 'create',
      name: 'New policy',
      mode: 'blocklist',
      software: [{ name: 'Foo' }],
    }, makeAuth()));

    expect(result.success).toBe(true);
  });
});
