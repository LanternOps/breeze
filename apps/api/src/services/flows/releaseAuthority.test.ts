import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool catalog W04 (#5219), plan Task A5: the release-time AuthContext of a
 * flow-origin intent. Structural, never user RBAC: the run's flow principal is
 * rebuilt from the run row and refused when the run's org is not one the flow
 * owns (assertFlowRunOwnership).
 */
const { loadFlowRunOwnership } = vi.hoisted(() => ({ loadFlowRunOwnership: vi.fn() }));
vi.mock('./intentClaimStore', () => ({ loadFlowRunOwnership }));
vi.mock('../../db', () => ({
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));

import { checkFlowReleaseAuthority } from './releaseAuthority';
import { isAutomationPrincipal, isFlowPrincipal } from '../../middleware/principalKind';
import type { ActionIntent } from '../../db/schema/actionIntents';

const RUN_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ORG_ID = 'cccccccc-0000-4000-8000-000000000001';
const OTHER_ORG = 'cccccccc-0000-4000-8000-000000000002';
const PARTNER_ID = 'dddddddd-0000-4000-8000-000000000001';
const OTHER_PARTNER = 'dddddddd-0000-4000-8000-000000000002';
const FLOW_ID = 'eeeeeeee-0000-4000-8000-000000000001';

const intent = { id: 'i-1', orgId: ORG_ID, requestingFlowRunId: RUN_ID } as unknown as ActionIntent;

function facts(over: { flow?: Record<string, unknown>; run?: Record<string, unknown>; orgPartnerId?: string | null } = {}) {
  return {
    run: { id: RUN_ID, orgId: ORG_ID, flowId: FLOW_ID, chainDepth: 0, ...over.run },
    flow: { id: FLOW_ID, orgId: ORG_ID, partnerId: null, status: 'enabled', name: 'Disk cleanup', ...over.flow },
    orgPartnerId: over.orgPartnerId === undefined ? PARTNER_ID : over.orgPartnerId,
  };
}

describe('checkFlowReleaseAuthority', () => {
  beforeEach(() => loadFlowRunOwnership.mockReset());

  it('returns a flow principal auth with orgId = run.orgId and aiOrigin kind flow', async () => {
    loadFlowRunOwnership.mockResolvedValue(facts());
    const out = await checkFlowReleaseAuthority(intent);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.auth.principal).toEqual({ kind: 'flow', flowId: FLOW_ID, runId: RUN_ID });
    expect(out.auth.orgId).toBe(ORG_ID);
    expect(out.auth.accessibleOrgIds).toEqual([ORG_ID]);
    expect(out.auth.aiOrigin).toEqual({ kind: 'flow', flowRunId: RUN_ID });
    expect(out.auth.token).toBeNull();
    expect(isFlowPrincipal(out.auth)).toBe(true);
    expect(isAutomationPrincipal(out.auth)).toBe(true);
    expect(loadFlowRunOwnership).toHaveBeenCalledWith(RUN_ID);
  });

  it('refuses when the run row is missing', async () => {
    loadFlowRunOwnership.mockResolvedValue(null);
    await expect(checkFlowReleaseAuthority(intent)).resolves.toEqual({ ok: false, code: 'run_not_found' });
  });

  it('refuses when the flow row is gone', async () => {
    loadFlowRunOwnership.mockResolvedValue({ ...facts(), flow: null });
    await expect(checkFlowReleaseAuthority(intent)).resolves.toEqual({ ok: false, code: 'flow_not_found' });
  });

  it('refuses when run org is not owned by the flow (partner flow, org of another partner)', async () => {
    loadFlowRunOwnership.mockResolvedValue(facts({ flow: { orgId: null, partnerId: OTHER_PARTNER } }));
    await expect(checkFlowReleaseAuthority(intent)).resolves.toEqual({ ok: false, code: 'ownership_mismatch' });
  });

  it('refuses an org flow whose run sits in another org', async () => {
    loadFlowRunOwnership.mockResolvedValue(facts({ flow: { orgId: OTHER_ORG } }));
    await expect(checkFlowReleaseAuthority(intent)).resolves.toEqual({ ok: false, code: 'ownership_mismatch' });
  });

  it('refuses when the run is not filed under the intent org (defense in depth over the composite FK)', async () => {
    loadFlowRunOwnership.mockResolvedValue(facts({ run: { orgId: OTHER_ORG }, flow: { orgId: OTHER_ORG } }));
    await expect(checkFlowReleaseAuthority(intent)).resolves.toEqual({ ok: false, code: 'ownership_mismatch' });
  });

  it('accepts a partner-wide flow running in an org of its own partner', async () => {
    loadFlowRunOwnership.mockResolvedValue(facts({ flow: { orgId: null, partnerId: PARTNER_ID } }));
    const out = await checkFlowReleaseAuthority(intent);
    expect(out.ok).toBe(true);
  });

  it('refuses a non-flow intent outright', async () => {
    await expect(checkFlowReleaseAuthority({ ...intent, requestingFlowRunId: null } as ActionIntent))
      .resolves.toEqual({ ok: false, code: 'run_not_found' });
    expect(loadFlowRunOwnership).not.toHaveBeenCalled();
  });
});
