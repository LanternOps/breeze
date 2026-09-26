import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * M4-D1 at the universal dispatch chokepoint: every topology tool passes the
 * site-pinned gate inside `executeTool` — whatever the transport — and its
 * handler receives ONLY the gate-issued site context. A caller cannot smuggle
 * its own `topologyRequest` through `opts.context`.
 */
const mocks = vi.hoisted(() => ({ gate: vi.fn(), capture: vi.fn(async (raw: string) => raw) }));
vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));
vi.mock('./topology/aiToolGate', async (original) => ({ ...await original<object>(), authorizeTopologyAiToolCall: mocks.gate }));
vi.mock('./artifacts/toolResultCapture', async (original) => ({ ...await original<object>(), captureLargeToolResult: mocks.capture }));

import { aiTools, executeTool } from './aiTools';
import type { ToolExecutionContext } from './toolExecutionContext';

const SITE = '20000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const SESSION = '30000000-0000-4000-8000-000000000001';
const auth = { user: { id: 'u' }, scope: 'organization', orgId: 'o', accessibleOrgIds: ['o'], orgCondition: () => undefined, canAccessOrg: () => true } as never;
const gateCtx = { auth, permissions: {}, scope: { orgId: 'o', siteId: SITE } };

let seen: ToolExecutionContext | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  seen = undefined;
  const tool = aiTools.get('get_link_health')!;
  vi.spyOn(tool, 'handler').mockImplementation(async (_input, _auth, context) => { seen = context; return JSON.stringify({ ok: true }); });
});

describe('executeTool topology gate (M4-D1)', () => {
  it('refuses the call when the gate refuses, and never runs the handler', async () => {
    mocks.gate.mockResolvedValue({ ok: false, code: 'topology_session_required', error: 'Topology tools run only inside a site-pinned topology investigation' });
    const result = JSON.parse(await executeTool('get_link_health', { site_id: SITE, relationship_id: REL }, auth));
    expect(result).toEqual({ error: 'Topology tools run only inside a site-pinned topology investigation', code: 'topology_session_required' });
    expect(mocks.gate).toHaveBeenCalledWith({ site_id: SITE, relationship_id: REL }, auth, undefined);
    expect(seen).toBeUndefined();
    expect(aiTools.get('get_link_health')!.handler).not.toHaveBeenCalled();
  });

  it('passes the transport binding to the gate and the gate context to the handler', async () => {
    mocks.gate.mockResolvedValue({ ok: true, ctx: gateCtx, pinnedSiteId: SITE, sessionId: SESSION });
    const binding = { kind: 'ai_session', sessionId: SESSION } as const;
    await executeTool('get_link_health', { site_id: SITE, relationship_id: REL }, auth, { topologyBinding: binding });
    expect(mocks.gate).toHaveBeenCalledWith(expect.anything(), auth, binding);
    expect(seen?.topologyRequest).toBe(gateCtx);
  });

  it('overwrites a caller-supplied topologyRequest instead of trusting it', async () => {
    const forged = { auth, permissions: {}, scope: { orgId: 'o', siteId: '20000000-0000-4000-8000-0000000000ff' } } as never;
    mocks.gate.mockResolvedValue({ ok: false, code: 'topology_session_required', error: 'x' });
    await executeTool('get_link_health', { site_id: SITE, relationship_id: REL }, auth, { context: { topologyRequest: forged } });
    expect(seen).toBeUndefined();
    mocks.gate.mockResolvedValue({ ok: true, ctx: gateCtx, pinnedSiteId: SITE, sessionId: null });
    await executeTool('get_link_health', { site_id: SITE, relationship_id: REL }, auth, { context: { topologyRequest: forged }, topologyBinding: { kind: 'mcp_site_key' } });
    expect(seen?.topologyRequest).toBe(gateCtx);
  });

  it('validates the strict input before the gate reads anything', async () => {
    const result = JSON.parse(await executeTool('get_link_health', { site_id: SITE, relationship_id: REL, orgId: 'x' }, auth, { topologyBinding: { kind: 'mcp_site_key' } }));
    expect(result.error).toBeTruthy();
    expect(mocks.gate).not.toHaveBeenCalled();
  });

  it('never artifact-captures a topology result (M4-D6)', async () => {
    mocks.gate.mockResolvedValue({ ok: true, ctx: gateCtx, pinnedSiteId: SITE, sessionId: SESSION });
    await executeTool('get_link_health', { site_id: SITE, relationship_id: REL }, auth, { topologyBinding: { kind: 'ai_session', sessionId: SESSION }, capture: { orgId: 'o', sessionId: SESSION } });
    expect(mocks.capture).toHaveBeenCalledWith(expect.any(String), null);
  });
});
