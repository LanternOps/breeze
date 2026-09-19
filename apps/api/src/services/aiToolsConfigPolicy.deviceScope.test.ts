/**
 * #6096 finding 11 — `configuration_policy_compliance` action `status` returned
 * the per-device compliance rows for every device the policy reaches, bounded
 * only by the policy's feature-link ids. A device-bound AI run could read the
 * compliance state (and `details`) of the whole fleet.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  withDbAccessContext: vi.fn(async (_c: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('./configurationPolicy', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getConfigPolicy: vi.fn(async () => ({ id: 'pol-1', name: 'Policy', orgId: 'org-1' })),
  listFeatureLinks: vi.fn(async () => [{ id: 'link-1' }]),
  createConfigPolicy: vi.fn(async () => ({ id: 'pol-new', name: 'New' })),
  addFeatureLink: vi.fn(async () => ({ id: 'link-new' })),
}));
vi.mock('../routes/policyManagement/helpers', () => ({
  getConfigPolicyComplianceRuleInfo: vi.fn(async () => ({})),
  getConfigPolicyComplianceStats: vi.fn(async () => ({ byFeatureLink: new Map() })),
  buildComplianceSummary: vi.fn(() => ({})),
}));

import { db } from '../db';
import { getConfigPolicyComplianceStats } from '../routes/policyManagement/helpers';
import { addFeatureLink } from './configurationPolicy';
import { registerConfigPolicyTools } from './aiToolsConfigPolicy';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerConfigPolicyTools(reg);
  return reg.get(name)!.handler;
}

function auth(allowedDeviceIds?: string[], allowedSiteIds?: string[]): AuthContext {
  return {
    principal: { kind: 'ai_agent' },
    user: { id: 'u1' },
    orgId: 'org-1',
    partnerId: 'partner-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedDeviceIds,
    allowedSiteIds,
    canAccessSite: (s: string | null | undefined) => (!allowedSiteIds ? true : !!s && allowedSiteIds.includes(s)),
  } as unknown as AuthContext;
}

function sqlValues(node: unknown, seen = new Set<unknown>(), out: unknown[] = []): unknown[] {
  if (node === null || node === undefined || typeof node !== 'object') { out.push(node); return out; }
  if (seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { for (const i of node) sqlValues(i, seen, out); return out; }
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) for (const i of chunks) sqlValues(i, seen, out);
  const value = (node as { value?: unknown }).value;
  if (value !== undefined) sqlValues(value, seen, out);
  return out;
}

const ROWS = [
  { configPolicyId: 'link-1', configItemName: 'x', deviceId: 'dev-1', status: 'compliant', details: {}, lastCheckedAt: null, remediationAttempts: 0 },
  { configPolicyId: 'link-1', configItemName: 'x', deviceId: 'dev-2', status: 'non_compliant', details: { secret: 'SIBLING-DETAIL' }, lastCheckedAt: null, remediationAttempts: 0 },
];

/**
 * The mock DB does not evaluate WHERE, so it APPLIES whatever device narrowing
 * the handler built — an un-narrowed query names no device and gets everything.
 */
function mockReads() {
  mockDb.select.mockImplementation(() => ({
    from: () => ({
      where: (where: unknown) => {
        const named = new Set(sqlValues(where).filter((v) => typeof v === 'string' && String(v).startsWith('dev-')));
        const rows = named.size === 0 ? ROWS : ROWS.filter((r) => named.has(r.deviceId));
        return { limit: () => Promise.resolve(rows) };
      },
    }),
  }));
}

describe('configuration_policy_compliance status — exact-device scope', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReads(); });

  it('hides a sibling device\'s compliance rows from a device-bound run', async () => {
    const out = JSON.parse(await handlerFor('configuration_policy_compliance')({ action: 'status', policyId: 'pol-1' }, auth(['dev-1'], ['site-1'])));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
    expect(JSON.stringify(out)).not.toContain('SIBLING-DETAIL');
  });

  it('hides them from a device-LESS analysis run too', async () => {
    const out = JSON.parse(await handlerFor('configuration_policy_compliance')({ action: 'status', policyId: 'pol-1' }, auth(['dev-1'], undefined)));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1']);
  });

  it('unrestricted caller still sees every device', async () => {
    const out = JSON.parse(await handlerFor('configuration_policy_compliance')({ action: 'status', policyId: 'pol-1' }, auth(undefined, undefined)));
    expect(out.devices.map((d: any) => d.deviceId)).toEqual(['dev-1', 'dev-2']);
  });
});

/**
 * #6096 residual 1 — the write gate on these org-wide governance objects is
 * `canMutateOrgWideGovernance`, which used to read the SITE ceiling only. A
 * device-LESS analysis run (allowedDeviceIds, no allowedSiteIds) sailed through
 * and could create/edit configuration policies that fan out to the whole org.
 */
describe('configuration-policy writes — exact-device ceiling', () => {
  beforeEach(() => { vi.clearAllMocks(); mockReads(); });

  it('refuses manage_configuration_policy create for a device-LESS analysis run', async () => {
    const out = JSON.parse(await handlerFor('manage_configuration_policy')(
      { action: 'create', name: 'Fleet policy' },
      auth(['dev-1'], undefined),
    ));
    expect(out.error).toMatch(/site-restricted/i);
  });

  it('refuses manage_policy_feature_link add for a device-bound run', async () => {
    const out = JSON.parse(await handlerFor('manage_policy_feature_link')(
      { action: 'add', configPolicyId: 'pol-1', featureType: 'patch', featurePolicyId: 'fp-1' },
      auth(['dev-1'], ['site-1']),
    ));
    expect(out.error).toMatch(/site-restricted/i);
    expect(addFeatureLink).not.toHaveBeenCalled();
  });

  it('an unrestricted caller is not blocked by this gate', async () => {
    const out = JSON.parse(await handlerFor('manage_configuration_policy')(
      { action: 'create', name: 'Fleet policy' },
      auth(undefined, undefined),
    ));
    // Other checks downstream may still object; what must NOT happen is the
    // ceiling refusal firing for a caller with neither ceiling.
    expect(out.error ?? '').not.toMatch(/site-restricted/i);
  });
});

/**
 * #6096 residual 2 — `configuration_policy_compliance` action `summary` called
 * getConfigPolicyComplianceStats with NO caller scope, so a device-bound run
 * got fleet-wide compliance counts.
 */
describe('configuration_policy_compliance summary — exact-device scope', () => {
  function mockSummaryReads() {
    mockDb.select
      .mockImplementationOnce(() => ({ from: () => ({ where: () => Promise.resolve([{ id: 'pol-1', name: 'Policy', status: 'active' }]) }) }))
      .mockImplementationOnce(() => ({ from: () => ({ where: () => Promise.resolve([{ id: 'link-1', configPolicyId: 'pol-1', featureType: 'patch' }]) }) }));
  }

  beforeEach(() => { vi.clearAllMocks(); mockSummaryReads(); });

  it('passes the caller device allowlist into the stats query', async () => {
    await handlerFor('configuration_policy_compliance')({ action: 'summary' }, auth(['dev-1'], undefined));
    expect(getConfigPolicyComplianceStats).toHaveBeenCalledTimes(1);
    const args = vi.mocked(getConfigPolicyComplianceStats).mock.calls[0]!;
    expect(args[0]).toEqual(['link-1']);
    expect(args[2]).toEqual(['dev-1']);
  });

  it('passes no device allowlist for an unrestricted caller', async () => {
    await handlerFor('configuration_policy_compliance')({ action: 'summary' }, auth(undefined, undefined));
    const args = vi.mocked(getConfigPolicyComplianceStats).mock.calls[0]!;
    expect(args[2]).toBeUndefined();
  });
});
