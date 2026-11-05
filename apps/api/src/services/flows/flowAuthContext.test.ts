import type { Context, Next } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  dbAccessContextFromAuth,
  isAiAgentPrincipal,
  isAutomationPrincipal,
  isFlowPrincipal,
  isInteractiveUserSession,
  requireMfa,
  requireOrg,
  requirePartner,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { checkPermissionRequirements, checkToolPermission } from '../aiGuardrails';
import { MissingAiOriginError, requireAiOrigin } from '../aiDispatch';
import {
  FlowRunOwnershipError,
  assertFlowRunOwnership,
  buildFlowAuthContext,
  flowDbAccessContext,
  type FlowIdentity,
} from './flowAuthContext';

const PARTNER_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_B = '22222222-2222-4222-8222-222222222222';
const ORG_1 = '33333333-3333-4333-8333-333333333333';
const ORG_2 = '44444444-4444-4444-8444-444444444444';
const ORG_FLOW_ID = '55555555-5555-4555-8555-555555555555';
const PARTNER_FLOW_ID = '66666666-6666-4666-8666-666666666666';
const RUN_ID = '77777777-7777-4777-8777-777777777777';

const orgFlow: FlowIdentity = { id: ORG_FLOW_ID, orgId: ORG_1, partnerId: null, status: 'enabled', name: 'Disk cleanup' };
const partnerFlow: FlowIdentity = { id: PARTNER_FLOW_ID, orgId: null, partnerId: PARTNER_A, status: 'enabled' };
const org1 = { id: ORG_1, partnerId: PARTNER_A };

describe('assertFlowRunOwnership — the ownership matrix', () => {
  it('admits an org flow running in its own org', () => {
    expect(() => assertFlowRunOwnership(orgFlow, { id: RUN_ID, orgId: ORG_1, flowId: ORG_FLOW_ID }, org1)).not.toThrow();
  });

  it('refuses an org flow running in another org', () => {
    expect(() =>
      assertFlowRunOwnership(orgFlow, { id: RUN_ID, orgId: ORG_2, flowId: ORG_FLOW_ID }, { id: ORG_2, partnerId: PARTNER_A }),
    ).toThrow(FlowRunOwnershipError);
  });

  it('admits a partner flow over an org of its own partner', () => {
    expect(() =>
      assertFlowRunOwnership(partnerFlow, { id: RUN_ID, orgId: ORG_1, flowId: PARTNER_FLOW_ID }, org1),
    ).not.toThrow();
  });

  it("refuses a partner flow over an org of another partner", () => {
    expect(() =>
      assertFlowRunOwnership(
        partnerFlow,
        { id: RUN_ID, orgId: ORG_2, flowId: PARTNER_FLOW_ID },
        { id: ORG_2, partnerId: PARTNER_B },
      ),
    ).toThrow(FlowRunOwnershipError);
  });

  it("refuses a run that belongs to a different flow", () => {
    expect(() =>
      assertFlowRunOwnership(orgFlow, { id: RUN_ID, orgId: ORG_1, flowId: PARTNER_FLOW_ID }, org1),
    ).toThrow(FlowRunOwnershipError);
  });

  it('refuses when the org reference is not the run org', () => {
    expect(() =>
      assertFlowRunOwnership(orgFlow, { id: RUN_ID, orgId: ORG_1, flowId: ORG_FLOW_ID }, { id: ORG_2, partnerId: PARTNER_A }),
    ).toThrow(FlowRunOwnershipError);
  });

  it('refuses a malformed flow that names neither owner axis', () => {
    expect(() =>
      assertFlowRunOwnership(
        { id: PARTNER_FLOW_ID, orgId: null, partnerId: null, status: 'enabled' },
        { id: RUN_ID, orgId: ORG_1, flowId: PARTNER_FLOW_ID },
        org1,
      ),
    ).toThrow(FlowRunOwnershipError);
  });

  it('buildFlowAuthContext enforces the same matrix', () => {
    expect(() =>
      buildFlowAuthContext(
        partnerFlow,
        { id: RUN_ID, orgId: ORG_2, flowId: PARTNER_FLOW_ID },
        { id: ORG_2, partnerId: PARTNER_B },
      ),
    ).toThrow(FlowRunOwnershipError);
  });
});

describe('buildFlowAuthContext', () => {
  const auth = buildFlowAuthContext(partnerFlow, { id: RUN_ID, orgId: ORG_1, flowId: PARTNER_FLOW_ID }, org1);

  it('builds an org-scoped, token-less flow principal pinned to the run org', () => {
    expect(auth.principal).toEqual({ kind: 'flow', flowId: PARTNER_FLOW_ID, runId: RUN_ID });
    expect(auth.token).toBeNull();
    expect(auth.scope).toBe('organization');
    expect(auth.orgId).toBe(ORG_1);
    expect(auth.partnerId).toBe(PARTNER_A);
    expect(auth.accessibleOrgIds).toEqual([ORG_1]);
    expect(auth.partnerOrgAccess).toBeNull();
    expect(auth.canAccessOrg(ORG_1)).toBe(true);
    expect(auth.canAccessOrg(ORG_2)).toBe(false);
    expect(auth.orgCondition).toBeTypeOf('function');
  });

  it('carries a synthetic attribution identity (the flow id), never a users row', () => {
    expect(auth.user.id).toBe(PARTNER_FLOW_ID);
    expect(auth.user.email).toBe(`flow+${PARTNER_FLOW_ID}@breeze.internal`);
    expect(auth.user.isPlatformAdmin).toBe(false);
    const named = buildFlowAuthContext(orgFlow, { id: RUN_ID, orgId: ORG_1, flowId: ORG_FLOW_ID }, org1);
    expect(named.user.name).toBe('Disk cleanup');
  });

  it('is an automation principal, a flow principal, and not an AI agent or a human session', () => {
    expect(isFlowPrincipal(auth)).toBe(true);
    expect(isAutomationPrincipal(auth)).toBe(true);
    expect(isAiAgentPrincipal(auth)).toBe(false);
    expect(isInteractiveUserSession(auth)).toBe(false);
  });

  it('carries no site or device allowlist (the delegation ceiling is enforced at enable)', () => {
    expect(auth.allowedSiteIds).toBeUndefined();
    expect(auth.allowedDeviceIds).toBeUndefined();
  });

  it('mints a flow aiOrigin naming the run', () => {
    expect(auth.aiOrigin).toEqual({ kind: 'flow', flowRunId: RUN_ID });
  });

  it('flow auth context passes aiDispatch.requireAiOrigin with kind flow', () => {
    expect(requireAiOrigin(auth, 'run_script')).toEqual({ kind: 'flow', flowRunId: RUN_ID });
    expect(() => requireAiOrigin({ ...auth, aiOrigin: undefined }, 'run_script')).toThrow(MissingAiOriginError);
  });

  it('never carries a user id in either DB access-context path', () => {
    const expected = {
      scope: 'organization',
      orgId: ORG_1,
      accessibleOrgIds: [ORG_1],
      accessiblePartnerIds: [],
      userId: null,
      currentPartnerId: PARTNER_A,
    };
    expect(flowDbAccessContext(ORG_1, PARTNER_A)).toEqual(expected);
    expect(dbAccessContextFromAuth(auth)).toMatchObject(expected);
  });
});

describe('flow principal user-RBAC denial', () => {
  const auth = buildFlowAuthContext(orgFlow, { id: RUN_ID, orgId: ORG_1, flowId: ORG_FLOW_ID }, org1);

  it('checkToolPermission denies every tool (the token-less fallback would otherwise grant it)', async () => {
    for (const tool of ['get_device_details', 'run_script', 'manage_tickets']) {
      expect(await checkToolPermission(tool, {}, auth), tool).toBe('Flow principals are never granted user permissions');
    }
  });

  it('checkPermissionRequirements denies, empty or not', async () => {
    expect(await checkPermissionRequirements(auth, [])).toBe('Flow principals are never granted user permissions');
    expect(await checkPermissionRequirements(auth, [{ resource: 'devices', action: 'write' }])).toBe(
      'Flow principals are never granted user permissions',
    );
  });

  const middlewareDenials: Array<{ name: string; run: (c: Context, n: Next) => unknown }> = [
    { name: 'requireScope', run: (c: Context, n: Next) => requireScope('organization')(c, n) },
    { name: 'requirePermission', run: (c: Context, n: Next) => requirePermission('devices', 'write')(c, n) },
    { name: 'requireMfa', run: (c: Context, n: Next) => requireMfa()(c, n) },
    { name: 'requireOrg', run: (c: Context, n: Next) => requireOrg(c, n) },
    { name: 'requirePartner', run: (c: Context, n: Next) => requirePartner(c, n) },
  ];

  it.each(middlewareDenials)('$name refuses a flow principal before any permissive fallback', async ({ run }) => {
    const context = { get: (key: string) => (key === 'auth' ? auth : undefined) } as unknown as Context;
    let reached = false;
    const next: Next = async () => {
      reached = true;
    };
    await expect(Promise.resolve().then(() => run(context, next))).rejects.toMatchObject({
      status: 403,
      message: 'Flows cannot call HTTP routes',
    });
    expect(reached).toBe(false);
  });
});
