import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { ActionIntent } from '../../db/schema';

/**
 * W5 PR C (#5220), Task C2 — releasing an approved Tier-3 flow-tool intent:
 * the binding is revalidated against the live flow and the run is started
 * with the APPROVER as the triggerer (rule 7 and ceiling re-checked for them).
 */

vi.mock('./flowTools', () => ({ resolveFlowToolForCall: vi.fn() }));
vi.mock('./toolRuns', () => ({ startToolRun: vi.fn() }));

import { resolveFlowToolForCall, type FlowToolDescriptor } from './flowTools';
import { startToolRun } from './toolRuns';
import { releaseFlowToolIntent } from './flowToolRelease';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const PUB = '77777777-7777-4777-8777-777777777777';
const INTENT = '99999999-9999-4999-8999-999999999999';
const APPROVER = '44444444-4444-4444-8444-444444444444';

function intent(over: Partial<ActionIntent> = {}): ActionIntent {
  return {
    id: INTENT, orgId: ORG, actionName: 'flow__disk', invokedFlowId: FLOW, toolRevision: `flowpub:${PUB}`,
    toolSourceToolId: null, arguments: { inputs: { count: 3, note: null }, orgId: ORG, idempotencyKey: 'k1' },
    decidedByUserId: APPROVER, source: 'chat', ...over,
  } as unknown as ActionIntent;
}
function descriptor(over: Partial<FlowToolDescriptor> = {}): FlowToolDescriptor {
  return {
    name: 'flow__disk', flowId: FLOW, flowName: 'Disk', publicationId: PUB, publicationSeq: 4,
    owner: { orgId: ORG, partnerId: PARTNER }, partnerWide: false, tier: 3, revision: `flowpub:${PUB}`,
    definition: { name: 'flow__disk', description: 'Flow: Disk', input_schema: {} },
    validate: () => ({ ok: true, value: { inputs: {}, orgId: null, idempotencyKey: null } }),
    ...over,
  };
}
const approver = { principal: { kind: 'user_session' }, user: { id: APPROVER }, scope: 'organization', orgId: ORG } as unknown as AuthContext;

beforeEach(() => {
  vi.mocked(resolveFlowToolForCall).mockReset().mockResolvedValue(descriptor());
  vi.mocked(startToolRun).mockReset().mockResolvedValue({ ok: true, runId: 'run-1', duplicate: false, runPath: '/flows/runs/run-1' });
});

describe('releaseFlowToolIntent', () => {
  it('approver becomes the triggerer; the intent org is the run org; the intent id dedupes a redelivered release', async () => {
    const r = await releaseFlowToolIntent(intent(), approver);
    expect(r).toEqual({ ok: true, result: { runId: 'run-1', runPath: '/flows/runs/run-1', duplicate: false } });
    expect(resolveFlowToolForCall).toHaveBeenCalledWith(approver, 'flow__disk', ORG);
    const [d, raw, via, triggerer, ctx] = vi.mocked(startToolRun).mock.calls[0]!;
    expect(d.publicationId).toBe(PUB);
    expect(via).toBe('ai_tool');
    expect(triggerer).toEqual({ kind: 'user', auth: approver });
    expect(ctx).toMatchObject({ defaultOrgId: ORG });
    // The coerced inputs go back as the call; orgId travels as the default org, never as an argument.
    expect(raw).toEqual({ count: 3, note: null, idempotencyKey: INTENT });
  });

  it('site-limited approver is refused', async () => {
    vi.mocked(startToolRun).mockResolvedValue({ ok: false, error: 'delegation_scope_restricted' });
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'delegation_scope_restricted' });
  });

  it('an approver lacking a step permission is refused with the list', async () => {
    vi.mocked(startToolRun).mockResolvedValue({ ok: false, error: 'permission_missing', missing: [{ stepId: 'run', permission: 'scripts.execute' }] });
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({
      ok: false, code: 'permission_missing', details: { missing: [{ stepId: 'run', permission: 'scripts.execute' }] },
    });
  });

  it('re-enabled flow fails the intent flow_tool_changed, and nothing is started', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(descriptor({ publicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', publicationSeq: 5 }));
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
    expect(startToolRun).not.toHaveBeenCalled();
  });

  it('a disabled, deleted or invisible flow fails flow_tool_changed', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(null);
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
  });

  it('a different flow now holding the slug fails flow_tool_changed', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(descriptor({ flowId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }));
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
  });

  it('an org flow that no longer belongs to the intent org is refused', async () => {
    vi.mocked(resolveFlowToolForCall).mockResolvedValue(descriptor({ owner: { orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', partnerId: PARTNER } }));
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'org_forbidden' });
  });

  it('a malformed binding is refused before any read', async () => {
    expect(await releaseFlowToolIntent(intent({ toolRevision: 'rev-1' }), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
    expect(await releaseFlowToolIntent(intent({ invokedFlowId: null }), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
    expect(await releaseFlowToolIntent(intent({ arguments: { inputs: 'x' } as never }), approver)).toEqual({ ok: false, code: 'flow_tool_changed' });
    expect(resolveFlowToolForCall).not.toHaveBeenCalled();
  });

  it('an admission refusal is the intent failure code', async () => {
    vi.mocked(startToolRun).mockResolvedValue({ ok: false, error: 'owner_monthly_cap_reached' });
    expect(await releaseFlowToolIntent(intent(), approver)).toEqual({ ok: false, code: 'owner_monthly_cap_reached' });
  });
});
