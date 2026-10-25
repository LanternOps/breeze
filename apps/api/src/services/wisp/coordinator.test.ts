/**
 * Wisp W07 — the coordinator's gating matrix (plan Task 3; Review Focus 2–5).
 * Every gate is one case. The launchers, the intent minting and every
 * external read are mocked; `assertWithinCeiling` and the policy table are
 * real, so the ceiling semantics under test are the production ones.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GrantCeiling } from './grantAuthority';

const h = vi.hoisted(() => ({
  wispEnabled: true,
  workspaceEnabled: true,
  killed: false,
  tables: {} as Record<string, unknown[][]>,
  hasEntitlement: vi.fn(async () => true),
  resolveGrantCeiling: vi.fn(),
  chargeableUnderGrant: vi.fn(async () => ({ ok: true }) as { ok: true } | { ok: false; reason: 'budget_exhausted' }),
  launch: {} as Record<string, ReturnType<typeof vi.fn<(ctx: unknown) => Promise<unknown>>>>,
  raiseSpecialistIntent: vi.fn(async () => ({ intentId: 'intent-1' })),
  getUserPermissions: vi.fn(),
  incSpecialistRequest: vi.fn(),
}));

function nextRows(table: string): unknown[] {
  const q = h.tables[table];
  if (!q || q.length === 0) throw new Error(`no queued rows for ${table}`);
  return q.shift()!;
}

vi.mock('../../db', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => {
        const name = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const b: Record<string, unknown> = {
          where: () => b,
          limit: () => Promise.resolve().then(() => nextRows(name)),
        };
        return b;
      },
    }),
  },
  runOutsideDbContext: <T>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T>(fn: () => T) => fn(),
}));
vi.mock('../../config/env', () => ({
  wispEnabled: () => h.wispEnabled,
  aiWorkspaceEnabled: () => h.workspaceEnabled,
}));
vi.mock('../aiKillState', () => ({ readAiKillState: async () => ({ killed: h.killed, epoch: 1 }) }));
vi.mock('../entitlements', () => ({ hasEntitlement: h.hasEntitlement }));
vi.mock('./grantAuthority', async (orig) => ({
  ...(await orig<typeof import('./grantAuthority')>()),
  resolveGrantCeiling: h.resolveGrantCeiling,
}));
vi.mock('./budget', () => ({ chargeableUnderGrant: h.chargeableUnderGrant }));
vi.mock('./specialistLaunchers', async (orig) => {
  const actual = await orig<typeof import('./specialistLaunchers')>();
  const kinds = ['sweep', 'analysis', 'operator_recipe', 'patch_plan', 'remediation_research', 'bulk_ticket_reply'];
  for (const k of kinds) h.launch[k] = vi.fn(async () => ({ admitted: true, runId: `run-${k}` }));
  return {
    specialistDedupeKey: actual.specialistDedupeKey,
    parseSpecialistParams: actual.parseSpecialistParams,
    SPECIALIST_LAUNCHERS: Object.fromEntries(kinds.map((k) => [k, (ctx: unknown) => h.launch[k]!(ctx)])),
  };
});
vi.mock('./specialistIntent', () => ({ raiseSpecialistIntent: h.raiseSpecialistIntent }));
vi.mock('../permissions', async (orig) => ({
  ...(await orig<typeof import('../permissions')>()),
  getUserPermissions: h.getUserPermissions,
}));
vi.mock('../wispMetrics', () => ({ incSpecialistRequest: h.incSpecialistRequest }));

import { deriveRequestId, requestSpecialist, type SpecialistRequester } from './coordinator';
import { GrantInactiveError } from './grantAuthority';
import { bulkReplyDigest } from './specialists/bulkTicketReply';
import type { SpecialistKind } from './specialistPolicy';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ORG_B = '00000000-0000-4000-8000-0000000000b1';
const PARTNER = '00000000-0000-4000-8000-0000000000a2';
const GRANT = '00000000-0000-4000-8000-0000000000a3';
const REV = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a5';
const GRANTOR = '00000000-0000-4000-8000-0000000000a6';
const APPROVER = '00000000-0000-4000-8000-0000000000a7';
const DEVICE = '00000000-0000-4000-8000-0000000000a8';
const TICKET = '00000000-0000-4000-8000-0000000000a9';

function ceiling(o: Partial<GrantCeiling> = {}): GrantCeiling {
  return {
    grantId: GRANT, revisionId: REV, partnerId: PARTNER, grantorUserId: GRANTOR, scopeOrgId: null, partnerWide: true,
    orgIds: new Set([ORG]), siteIds: null, permissionKeys: new Set(['*:*']), toolAllowlist: null,
    deniedTools: new Set(), orgTerms: new Map(), status: 'active', ...o,
  };
}

const PARAMS: Record<SpecialistKind, Record<string, unknown>> = {
  sweep: {},
  analysis: { goal: 'Why are backups failing at Greenwood?' },
  operator_recipe: { workflowKey: 'service_recovery', workflowVersion: 1, objective: 'Restart spooler', recipeInput: {} },
  patch_plan: {},
  remediation_research: { deviceId: DEVICE },
  bulk_ticket_reply: { concernId: null, ticketIds: [TICKET], message: 'We are on it.' },
};

function base(o: { kind?: SpecialistKind; params?: Record<string, unknown>; orgId?: string; requestedByRunId?: string | null } = {}) {
  const kind = o.kind ?? 'sweep';
  return {
    grantId: GRANT, grantRevisionId: REV, orgId: o.orgId ?? ORG, kind,
    params: o.params ?? PARAMS[kind], requestedByRunId: o.requestedByRunId === undefined ? RUN : o.requestedByRunId,
  };
}

function fakeAuth(userId: string): never {
  return {
    user: { id: userId }, partnerId: PARTNER, orgId: null, scope: 'partner',
    canAccessOrg: (id: string) => id === ORG,
  } as never;
}

function requesterOf(kind: 'run' | 'user' | 'approval'): SpecialistRequester {
  if (kind === 'run') return { kind: 'run' };
  if (kind === 'user') return { kind: 'user', auth: fakeAuth(GRANTOR) };
  return { kind: 'approval', intentId: 'intent-9', auth: fakeAuth(APPROVER), pinnedDigest: 'pinned' };
}

/** Grant row + (when requestedByRunId is set) the requesting run row. */
function seed(o: { run?: Record<string, unknown> | null } = {}): void {
  h.tables.wisp_grants = [[{ partnerId: PARTNER }]];
  h.tables.ai_agent_runs = [[o.run === null ? undefined : { grantId: GRANT, orgId: ORG, depth: 0, profile: 'assessment', ...(o.run ?? {}) }].filter(Boolean) as unknown[]];
}

function perms(list: Array<{ resource: string; action: string }>) {
  return { permissions: list, partnerId: PARTNER, orgId: null, roleId: 'r', scope: 'partner', orgAccess: 'all', orgIds: [] };
}

const launchCalls = () => Object.values(h.launch).reduce((n, f) => n + f.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  h.wispEnabled = true;
  h.workspaceEnabled = true;
  h.killed = false;
  h.tables = {};
  h.hasEntitlement.mockResolvedValue(true);
  h.resolveGrantCeiling.mockResolvedValue(ceiling());
  h.chargeableUnderGrant.mockResolvedValue({ ok: true });
  h.raiseSpecialistIntent.mockResolvedValue({ intentId: 'intent-1' });
  h.getUserPermissions.mockResolvedValue(perms([{ resource: '*', action: '*' }]));
  for (const f of Object.values(h.launch)) f.mockResolvedValue({ admitted: true, runId: 'run-x' });
  seed();
});

describe('requestSpecialist gating matrix', () => {
  it.each([
    ['sweep', 'run', 'admitted'], ['analysis', 'run', 'admitted'],
    ['operator_recipe', 'run', 'needsApproval'], ['patch_plan', 'run', 'needsApproval'],
    ['remediation_research', 'run', 'needsApproval'], ['bulk_ticket_reply', 'run', 'needsApproval'],
    ['operator_recipe', 'user', 'admitted'], ['patch_plan', 'approval', 'admitted'],
    ['bulk_ticket_reply', 'user', 'admitted'], ['bulk_ticket_reply', 'approval', 'admitted'],
  ] as const)('%s from %s → %s', async (kind, requester, expected) => {
    const r = await requestSpecialist(base({ kind, requestedByRunId: requester === 'user' ? null : RUN }), { requester: requesterOf(requester), requestId: 'req-1' });
    expect(Object.keys(r)[0]).toBe(expected);
    if (expected === 'needsApproval') {
      expect(launchCalls()).toBe(0);
      expect(h.raiseSpecialistIntent).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-1', kind, orgId: ORG, grantId: GRANT, grantRevisionId: REV, requestedByRunId: RUN,
      }));
    } else {
      expect(h.launch[kind]).toHaveBeenCalledTimes(1);
      expect(h.raiseSpecialistIntent).not.toHaveBeenCalled();
    }
  });

  it('passes the pinned grant, lineage, grantor and the acting human to the launcher', async () => {
    await requestSpecialist(base({ kind: 'patch_plan' }), { requester: requesterOf('approval'), requestId: 'req-2' });
    const ctx = h.launch.patch_plan!.mock.calls[0]![0] as Record<string, unknown>;
    expect(ctx).toMatchObject({
      orgId: ORG, partnerId: PARTNER, grantorUserId: GRANTOR, requestId: 'req-2',
      grant: { grantId: GRANT, grantRevisionId: REV, requestedByRunId: RUN }, pinnedDigest: null,
    });
    seed();
    await requestSpecialist(base({ kind: 'bulk_ticket_reply' }), { requester: requesterOf('approval'), requestId: 'req-3' });
    expect((h.launch.bulk_ticket_reply!.mock.calls[0]![0] as Record<string, unknown>).pinnedDigest).toBe('pinned');
    expect((ctx.actorAuth as { user: { id: string } }).user.id).toBe(APPROVER);
  });

  it('the run path launches with no acting human; the user path pins the bulk digest from the params it parsed', async () => {
    await requestSpecialist(base({ kind: 'sweep' }), { requestId: 'r' });
    expect((h.launch.sweep!.mock.calls[0]![0] as Record<string, unknown>).actorAuth).toBeNull();
    seed();
    await requestSpecialist(base({ kind: 'bulk_ticket_reply', requestedByRunId: null }), { requester: requesterOf('user'), requestId: 'r2' });
    expect((h.launch.bulk_ticket_reply!.mock.calls[0]![0] as Record<string, unknown>).pinnedDigest)
      .toBe(bulkReplyDigest({ ticketIds: [TICKET], message: 'We are on it.' }));
  });

  it('refuses wisp_disabled when the flag is off and calls nothing', async () => {
    h.wispEnabled = false;
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'wisp_disabled' });
    expect(h.hasEntitlement).not.toHaveBeenCalled();
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
    expect(launchCalls()).toBe(0);
  });

  it('refuses wisp_disabled under the AI kill switch (never bypassed)', async () => {
    h.killed = true;
    await expect(requestSpecialist(base())).resolves.toMatchObject({ refused: 'wisp_disabled' });
    expect(launchCalls()).toBe(0);
  });

  it('refuses not_entitled before touching the grant ceiling', async () => {
    h.hasEntitlement.mockResolvedValue(false);
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'not_entitled' });
    expect(h.hasEntitlement).toHaveBeenCalledWith(PARTNER, 'wisp');
    expect(h.resolveGrantCeiling).not.toHaveBeenCalled();
  });

  it('refuses grant_inactive when the grant row is missing', async () => {
    h.tables.wisp_grants = [[]];
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'grant_inactive' });
  });

  it('refuses grant_inactive on GrantInactiveError', async () => {
    h.resolveGrantCeiling.mockRejectedValue(new GrantInactiveError(GRANT, 'paused'));
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'grant_inactive' });
    expect(launchCalls()).toBe(0);
  });

  it('refuses org_out_of_ceiling before any launcher call (Review Focus 4)', async () => {
    await expect(requestSpecialist(base({ orgId: ORG_B }))).resolves.toEqual({ refused: 'org_out_of_ceiling' });
    expect(h.chargeableUnderGrant).not.toHaveBeenCalled();
    expect(launchCalls()).toBe(0);
    expect(h.raiseSpecialistIntent).not.toHaveBeenCalled();
  });

  it('refuses org_out_of_ceiling for a one-org grant naming another org', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ scopeOrgId: ORG, partnerWide: false, orgIds: new Set([ORG, ORG_B]) }));
    await expect(requestSpecialist(base({ orgId: ORG_B }))).resolves.toEqual({ refused: 'org_out_of_ceiling' });
  });

  it('refuses org_out_of_ceiling for a site-restricted grant (specialists are org-wide work)', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ siteIds: new Set(['site-1']) }));
    await expect(requestSpecialist(base())).resolves.toMatchObject({ refused: 'org_out_of_ceiling' });
  });

  it.each([
    ['a child (depth 1)', { depth: 1 }],
    ['not an assessment', { profile: 'sweep' }],
    ['under another grant', { grantId: 'g-other' }],
    ['in another org', { orgId: ORG_B }],
  ])('refuses depth_exceeded when the requesting run is %s', async (_l, run) => {
    seed({ run });
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'depth_exceeded' });
    expect(launchCalls()).toBe(0);
  });

  it('refuses depth_exceeded on the run path without a requesting run, or when it does not exist', async () => {
    await expect(requestSpecialist(base({ requestedByRunId: null }))).resolves.toEqual({ refused: 'depth_exceeded' });
    seed({ run: null });
    await expect(requestSpecialist(base())).resolves.toEqual({ refused: 'depth_exceeded' });
  });

  it('refuses unknown_kind and invalid_params', async () => {
    await expect(requestSpecialist({ ...base(), kind: 'run_script' as SpecialistKind })).resolves.toEqual({ refused: 'unknown_kind' });
    seed();
    await expect(requestSpecialist(base({ kind: 'analysis', params: { goal: '' } }))).resolves.toEqual({ refused: 'invalid_params' });
    seed();
    await expect(requestSpecialist(base({ kind: 'sweep', params: { extra: 1 } }))).resolves.toEqual({ refused: 'invalid_params' });
    expect(launchCalls()).toBe(0);
  });

  it('refuses budget_exhausted for an auto-admit kind and records the metric (Review Focus 5)', async () => {
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await expect(requestSpecialist(base({ kind: 'sweep' }))).resolves.toEqual({ refused: 'budget_exhausted' });
    expect(h.chargeableUnderGrant).toHaveBeenCalledWith(GRANT, 25);
    expect(launchCalls()).toBe(0);
    expect(h.incSpecialistRequest).toHaveBeenCalledWith('sweep', 'refused');
  });

  it('refuses budget_exhausted before minting an approval card too', async () => {
    h.chargeableUnderGrant.mockResolvedValue({ ok: false, reason: 'budget_exhausted' });
    await expect(requestSpecialist(base({ kind: 'patch_plan' }))).resolves.toEqual({ refused: 'budget_exhausted' });
    expect(h.raiseSpecialistIntent).not.toHaveBeenCalled();
  });

  it('refuses workspace_execute_required for analysis when the grantor lacks ai_workspace:execute', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['ai_agents:write']) }));
    await expect(requestSpecialist(base({ kind: 'analysis' }))).resolves.toEqual({ refused: 'workspace_execute_required' });
    expect(launchCalls()).toBe(0);
  });

  it('refuses permission_missing when the grantor lacks ai_agents:write', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['ai_workspace:execute']) }));
    await expect(requestSpecialist(base({ kind: 'sweep' }))).resolves.toEqual({ refused: 'permission_missing' });
  });

  it('refuses permission_missing for bulk_ticket_reply without tickets:write in the ceiling', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({ permissionKeys: new Set(['ai_agents:write']) }));
    await expect(requestSpecialist(base({ kind: 'bulk_ticket_reply', requestedByRunId: null }), { requester: requesterOf('user') }))
      .resolves.toEqual({ refused: 'permission_missing' });
  });

  it('an org term narrowing the grantor in this org refuses even when the ceiling-wide keys allow', async () => {
    h.resolveGrantCeiling.mockResolvedValue(ceiling({
      orgTerms: new Map([[ORG, { permissionKeys: new Set(['ai_agents:write']), siteIds: null }]]),
    }));
    await expect(requestSpecialist(base({ kind: 'analysis' }))).resolves.toEqual({ refused: 'workspace_execute_required' });
  });

  it('refuses workspace_execute_required for analysis when the approver lacks it even though the grantor holds it (Review Focus 2)', async () => {
    h.getUserPermissions.mockResolvedValue(perms([{ resource: 'ai_agents', action: 'write' }, { resource: 'ai_sessions', action: 'use' }]));
    await expect(requestSpecialist(base({ kind: 'analysis' }), { requester: requesterOf('approval') }))
      .resolves.toEqual({ refused: 'workspace_execute_required' });
    expect(h.getUserPermissions).toHaveBeenCalledWith(APPROVER, expect.objectContaining({ partnerId: PARTNER, scope: 'partner' }));
    expect(launchCalls()).toBe(0);
  });

  it('refuses permission_missing when the approver has no permissions row, or cannot reach the org', async () => {
    h.getUserPermissions.mockResolvedValue(null);
    await expect(requestSpecialist(base({ kind: 'patch_plan' }), { requester: requesterOf('approval') }))
      .resolves.toEqual({ refused: 'permission_missing' });
    seed();
    h.getUserPermissions.mockResolvedValue(perms([{ resource: '*', action: '*' }]));
    const outsider = { kind: 'approval' as const, intentId: 'i', auth: { ...fakeAuth(APPROVER) as object, canAccessOrg: () => false } as never };
    await expect(requestSpecialist(base({ kind: 'patch_plan' }), { requester: outsider })).resolves.toEqual({ refused: 'permission_missing' });
  });

  it('refuses analysis while the sandbox (aiWorkspaceEnabled) is off — never bypassed', async () => {
    h.workspaceEnabled = false;
    await expect(requestSpecialist(base({ kind: 'analysis' }))).resolves.toMatchObject({ refused: 'admission_skipped', detail: 'analysis_not_available' });
    expect(launchCalls()).toBe(0);
  });

  it('a launcher refusal comes back as-is; an admission skip carries its name in detail', async () => {
    h.launch.sweep!.mockResolvedValue({ refused: 'no_sweep_schedule' });
    await expect(requestSpecialist(base({ kind: 'sweep' }))).resolves.toEqual({ refused: 'no_sweep_schedule' });
    seed();
    h.launch.sweep!.mockResolvedValue({ refused: 'admission_skipped', detail: 'cooldown' });
    await expect(requestSpecialist(base({ kind: 'sweep' }))).resolves.toEqual({ refused: 'admission_skipped', detail: 'cooldown' });
    expect(h.incSpecialistRequest).toHaveBeenLastCalledWith('sweep', 'refused');
  });

  it('is idempotent by requestId: the same id reaches the launcher, which returns the same runId (Review Focus 3)', async () => {
    h.launch.analysis!.mockResolvedValue({ admitted: true, runId: 'run-same' });
    const a = await requestSpecialist(base({ kind: 'analysis' }), { requestId: 'req-dup' });
    seed();
    const b = await requestSpecialist(base({ kind: 'analysis' }), { requestId: 'req-dup' });
    expect(a).toEqual({ admitted: true, runId: 'run-same' });
    expect(b).toEqual(a);
    const ids = h.launch.analysis!.mock.calls.map((c) => (c[0] as { requestId: string }).requestId);
    expect(ids).toEqual(['req-dup', 'req-dup']);
  });

  it('records needs_approval and admitted metrics', async () => {
    await requestSpecialist(base({ kind: 'patch_plan' }));
    expect(h.incSpecialistRequest).toHaveBeenLastCalledWith('patch_plan', 'needs_approval');
    seed();
    await requestSpecialist(base({ kind: 'sweep' }));
    expect(h.incSpecialistRequest).toHaveBeenLastCalledWith('sweep', 'admitted');
  });

  it('deriveRequestId is a stable uuid for (runId, ordinal) and distinct across ordinals', () => {
    expect(deriveRequestId('r', 0)).toBe(deriveRequestId('r', 0));
    expect(deriveRequestId('r', 0)).not.toBe(deriveRequestId('r', 1));
    expect(deriveRequestId('r', 0)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
