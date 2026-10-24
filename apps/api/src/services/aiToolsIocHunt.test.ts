/**
 * AI `ioc_hunt` tool (#6263 W05, PR B). Handler behaviour over mocked PR A
 * services; tiering, scope and digest pins are pinned in the guardrail and
 * effect-digest suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

vi.mock('./securityScanSweeps', () => ({
  previewSweep: vi.fn(),
  createSweep: vi.fn(),
  cancelSweep: vi.fn(),
  listSweeps: vi.fn(),
  getSweep: vi.fn(),
}));
vi.mock('./securityScanSweepHits', () => ({ topSweepRuleHits: vi.fn() }));
vi.mock('./yaraRuleSetAccess', () => ({ listVisibleRuleSets: vi.fn() }));
vi.mock('./aiToolDbContext', () => ({ inToolDbPhase: vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn()) }));

import * as sweeps from './securityScanSweeps';
import * as hits from './securityScanSweepHits';
import * as ruleSets from './yaraRuleSetAccess';
import { IOC_HUNT_ACTIONS, registerIocHuntTools } from './aiToolsIocHunt';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const SET_A = '22222222-2222-4222-8222-222222222222';
const SWEEP = '33333333-3333-4333-8333-333333333333';
const DIGEST = 'd'.repeat(64);

const auth = {
  scope: 'organization', orgId: ORG, partnerId: 'p-1', accessibleOrgIds: [ORG],
  user: { id: 'u-1', email: 'u@example.test' },
  canAccessOrg: (id: string) => id === ORG,
  orgCondition: () => undefined,
  aiOrigin: { kind: 'ai_assistant', sessionId: 's-1' },
} as unknown as AuthContext;

function tool(): AiTool {
  const m = new Map<string, AiTool>();
  registerIocHuntTools(m);
  return m.get('ioc_hunt')!;
}
const call = (input: Record<string, unknown>) => tool().handler(input, auth).then((s) => JSON.parse(s));

const summary = {
  id: SWEEP, groupId: 'g-1', orgId: ORG, orgName: 'Acme', ruleSets: [{ id: SET_A, name: 'Advisory 7', version: 3 }],
  scanType: 'quick', state: 'active', targeted: 4, skipped: {},
  progress: { queued: 1, running: 1, completed: 2, timedOut: 0, failed: 0, cancelled: 0, expired: 0, degraded: 1, threatsFound: 5 },
  origin: 'ai_chat', createdBy: { id: 'u-1', name: 'U' }, createdAt: '2026-10-24T00:00:00.000Z',
  expiresAt: '2026-10-25T00:00:00.000Z', completedAt: null,
};

describe('ioc_hunt registration', () => {
  it('is a base-Tier-1 security tool whose description names all seven actions', () => {
    const t = tool();
    expect(t.tier).toBe(1);
    expect(t.domain).toBe('security');
    expect(t.deviceArgs).toBeUndefined();
    expect(t.selfManagedDbContext).toEqual(['sweep', 'cancel_sweep']);
    const desc = t.definition.description!;
    expect(desc.length).toBeLessThanOrEqual(300);
    for (const a of IOC_HUNT_ACTIONS) expect(desc).toContain(a);
    expect(desc).not.toMatch(/\b(EDR|antivirus|real-time protection|prevention)\b/i);
    const schema = t.definition.input_schema as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.properties.action.enum).toEqual([...IOC_HUNT_ACTIONS]);
    expect(schema.required).toEqual(['action']);
  });
});

describe('ioc_hunt reads', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('list_rule_sets returns visible sets with owner kind, paged', async () => {
    vi.mocked(ruleSets.listVisibleRuleSets).mockResolvedValue({
      data: [
        { id: SET_A, name: 'Advisory 7', ownerKind: 'org', orgId: ORG, enabled: true, autoQuarantine: false, publishedVersion: 3, stale: false, ruleCount: 12 },
        { id: 'b', name: 'Breeze pack', ownerKind: 'builtin', orgId: null, enabled: true, autoQuarantine: false, publishedVersion: 9, stale: false, ruleCount: 400 },
      ],
      total: 2, page: 1, limit: 25,
    });
    const out = await call({ action: 'list_rule_sets', orgId: ORG });
    expect(out.ruleSets.map((r: { ownerKind: string }) => r.ownerKind)).toEqual(['org', 'builtin']);
    expect(out).toMatchObject({ total: 2, page: 1, limit: 25 });
    expect(ruleSets.listVisibleRuleSets).toHaveBeenCalledWith(auth, { orgId: ORG, page: 1, limit: 25 });
  });

  it('preview_sweep is single-org, writes nothing and returns the previewDigest', async () => {
    vi.mocked(sweeps.previewSweep).mockResolvedValue({
      ok: true,
      preview: {
        targeted: 12, byOrg: [{ orgId: ORG, orgName: 'Acme', targeted: 12 }],
        skipped: { agent_too_old: 1, busy_same_sweep: 0, rule_set_not_eligible: 0 },
        ruleSets: [{ id: SET_A, name: 'Advisory 7', version: 3 }], previewDigest: DIGEST,
      },
    });
    const input = { action: 'preview_sweep', orgId: ORG, ruleSetIds: [SET_A], scope: { kind: 'sites', siteIds: [SET_A] }, scanType: 'quick' };
    const out = await call(input);
    expect(out).toMatchObject({ orgId: ORG, orgName: 'Acme', targeted: 12, expectedDeviceCount: 12, previewDigest: DIGEST });
    expect(sweeps.previewSweep).toHaveBeenCalledWith(
      auth,
      { ruleSetIds: [SET_A], scope: { kind: 'sites', siteIds: [SET_A] }, scanType: 'quick' },
      { onlyOrgId: ORG },
    );
    expect(sweeps.createSweep).not.toHaveBeenCalled();
  });

  it('preview_sweep refuses a foreign or multi-org scope, and a missing orgId', async () => {
    const base = { action: 'preview_sweep', ruleSetIds: [SET_A], scanType: 'quick' };
    expect(await call({ ...base, orgId: ORG, scope: { kind: 'orgs', orgIds: [OTHER_ORG] } })).toMatchObject({ error: 'single_org_only' });
    expect(await call({ ...base, orgId: ORG, scope: { kind: 'orgs', orgIds: [ORG, OTHER_ORG] } })).toMatchObject({ error: 'single_org_only' });
    expect(await call({ ...base, scope: { kind: 'all' } })).toMatchObject({ error: 'invalid_input' });
    expect(sweeps.previewSweep).not.toHaveBeenCalled();
    // The one org named exactly is allowed.
    vi.mocked(sweeps.previewSweep).mockResolvedValue({ ok: false, status: 403, code: 'ORG_ACCESS_DENIED' } as never);
    expect(await call({ ...base, orgId: ORG, scope: { kind: 'orgs', orgIds: [ORG] } })).toMatchObject({ error: 'ORG_ACCESS_DENIED', code: 'ORG_ACCESS_DENIED', status: 403 });
  });

  it('list_sweeps passes paging and the org through and returns ceiling-filtered summaries', async () => {
    vi.mocked(sweeps.listSweeps).mockResolvedValue({ data: [summary], total: 1, page: 2, limit: 10 } as never);
    const out = await call({ action: 'list_sweeps', orgId: ORG, page: 2, limit: 10 });
    expect(out).toEqual({ sweeps: [summary], total: 1, page: 2, limit: 10 });
    expect(sweeps.listSweeps).toHaveBeenCalledWith(auth, { orgId: ORG, page: 2, limit: 10 });
  });

  it('sweep_status returns progress, degraded, threats found and the top rule hits; 404 → not_found', async () => {
    vi.mocked(sweeps.getSweep).mockResolvedValueOnce(summary as never);
    vi.mocked(hits.topSweepRuleHits).mockResolvedValue([{ ruleName: 'ioc_md5_advisory', ruleSetId: SET_A, hits: 3 }]);
    const out = await call({ action: 'sweep_status', sweepId: SWEEP });
    expect(out.sweep).toEqual(summary);
    expect(out.degraded).toBe(1);
    expect(out.threatsFound).toBe(5);
    expect(out.topRules).toEqual([{ ruleName: 'ioc_md5_advisory', ruleSetId: SET_A, hits: 3 }]);
    expect(hits.topSweepRuleHits).toHaveBeenCalledWith(auth, summary, 10);

    vi.mocked(sweeps.getSweep).mockResolvedValueOnce(null);
    expect(await call({ action: 'sweep_status', sweepId: SWEEP })).toEqual({ error: 'not_found' });
    expect(await call({ action: 'sweep_status', sweepId: 'nope' })).toMatchObject({ error: 'invalid_input' });
  });
});

describe('ioc_hunt exposure and limits', () => {
  it('is in no agent preset: human-only and unreachable for the ai_agent principal (Gate B 10)', { timeout: 180_000 }, async () => {
    const { AGENT_HUMAN_ONLY_TOOLS } = await import('./aiToolExposure');
    expect(AGENT_HUMAN_ONLY_TOOLS.has('ioc_hunt')).toBe(true);
    const { listAgentReachableTools } = await import('./aiAgents/agentToolCatalog');
    expect(listAgentReachableTools()).not.toContain('ioc_hunt');
  });

  it('rate limit is 30 per 600 s', { timeout: 180_000 }, async () => {
    const { TOOL_RATE_LIMITS } = await import('./aiToolRateLimits');
    expect(TOOL_RATE_LIMITS.ioc_hunt).toEqual({ limit: 30, windowSeconds: 600 });
  });
});
