import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

vi.mock('./flows/service', () => ({ saveDraftFlow: vi.fn(), getFlow: vi.fn(), listFlows: vi.fn() }));
vi.mock('./flows/owner', () => ({ resolveFlowOwnerForCaller: vi.fn() }));
vi.mock('./flowValidator', () => ({ validateFlowDocument: vi.fn() }));

import { getFlow, listFlows, saveDraftFlow } from './flows/service';
import { resolveFlowOwnerForCaller } from './flows/owner';
import { validateFlowDocument } from './flowValidator';
import { FLOW_TOOL_NAMES, registerFlowTools } from './aiToolsFlows';
import { isToolEnvGatedOff } from './aiToolEnvGates';

const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const auth = { scope: 'organization', orgId: 'o', user: { id: 'u' } } as unknown as AuthContext;

function tools(): Map<string, AiTool> {
  const m = new Map<string, AiTool>();
  registerFlowTools(m);
  return m;
}
const call = (name: string, input: Record<string, unknown>) => tools().get(name)!.handler(input, auth).then((s) => JSON.parse(s));

describe('flow AI tools', () => {
  beforeEach(() => {
    vi.stubEnv('FLOWS_ENABLED', 'true');
    vi.mocked(saveDraftFlow).mockReset();
    vi.mocked(getFlow).mockReset();
    vi.mocked(listFlows).mockReset();
    vi.mocked(resolveFlowOwnerForCaller).mockReset();
    vi.mocked(validateFlowDocument).mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('registers exactly the four tools with their tiers and domain', () => {
    const m = tools();
    expect([...m.keys()].sort()).toEqual([...FLOW_TOOL_NAMES].sort());
    expect(m.get('draft_flow')!.tier).toBe(2);
    for (const n of ['validate_flow', 'get_flow', 'list_flows']) expect(m.get(n)!.tier).toBe(1);
    for (const t of m.values()) {
      expect(t.domain).toBe('scripts');
      expect(t.deviceArgs).toEqual([]);
      expect(t.alwaysLoad).toBeUndefined();
    }
  });

  it('every handler returns flows_disabled with the flag off', async () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    for (const name of FLOW_TOOL_NAMES) {
      expect(await call(name, { document: {}, flowId: FLOW_ID })).toEqual({ error: 'flows_disabled' });
    }
    expect(saveDraftFlow).not.toHaveBeenCalled();
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('validate_flow naming an inaccessible org returns the owner error and never calls the validator', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ error: 'Cannot access another organization' });
    expect(await call('validate_flow', { document: {}, orgId: FLOW_ID })).toEqual({ error: 'Cannot access another organization' });
    expect(resolveFlowOwnerForCaller).toHaveBeenCalledWith(auth, { ownerScope: undefined, orgId: FLOW_ID }, 'read');
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('validate_flow on a broken document returns the validator issues and drops the parsed document', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ owner: { orgId: 'o', partnerId: 'p' } });
    vi.mocked(validateFlowDocument).mockResolvedValue({
      valid: false, effectiveTier: null, steps: [], issues: [{ code: 'schema', severity: 'error', message: 'bad' }],
    });
    const out = await call('validate_flow', { document: { steps: 'x' } });
    expect(out).toEqual({ valid: false, effectiveTier: null, steps: [], issues: [{ code: 'schema', severity: 'error', message: 'bad' }] });
  });

  it('draft_flow maps a saved result with reviewPath', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: true, flow: { id: FLOW_ID } as never, validation: { valid: true } as never });
    const out = await call('draft_flow', { document: { a: 1 }, ownerScope: 'organization' });
    expect(out).toMatchObject({ saved: true, reviewPath: `/flows/${FLOW_ID}` });
    expect(saveDraftFlow).toHaveBeenCalledWith(auth, expect.objectContaining({ document: { a: 1 }, ownerScope: 'organization' }));
  });

  it('draft_flow passes validation failures and partner-wide denials through without reviewPath', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, validation: { valid: false } as never });
    expect(await call('draft_flow', { document: {} })).toEqual({ saved: false, validation: { valid: false } });
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'denied' });
    expect(await call('draft_flow', { document: {} })).toEqual({ saved: false, error: 'denied' });
  });

  it('draft_flow never forwards session provenance from input', async () => {
    vi.mocked(saveDraftFlow).mockResolvedValue({ saved: false, error: 'x' });
    await call('draft_flow', { document: {}, aiSessionId: FLOW_ID });
    expect(vi.mocked(saveDraftFlow).mock.calls[0]![1]).not.toHaveProperty('aiSessionId');
  });

  it('get_flow of an invisible id ⇒ flow_not_found', async () => {
    vi.mocked(getFlow).mockResolvedValue(null);
    expect(await call('get_flow', { flowId: FLOW_ID })).toEqual({ error: 'flow_not_found' });
  });

  it('list_flows passes the filter through', async () => {
    vi.mocked(listFlows).mockResolvedValue({ flows: [], total: 0 });
    expect(await call('list_flows', { status: 'draft', limit: 5 })).toEqual({ flows: [], total: 0 });
    expect(listFlows).toHaveBeenCalledWith(auth, { orgId: undefined, status: 'draft', limit: 5 });
  });
});

describe('isToolEnvGatedOff', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('gates the four flow tools on FLOWS_ENABLED and nothing else', () => {
    vi.stubEnv('FLOWS_ENABLED', 'false');
    for (const n of FLOW_TOOL_NAMES) expect(isToolEnvGatedOff(n)).toBe(true);
    expect(isToolEnvGatedOff('get_device_details')).toBe(false);
    vi.stubEnv('FLOWS_ENABLED', 'true');
    for (const n of FLOW_TOOL_NAMES) expect(isToolEnvGatedOff(n)).toBe(false);
  });
});
