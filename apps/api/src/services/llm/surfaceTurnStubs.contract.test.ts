/**
 * #11393 W04 T10 contracts for the `surface_turn` verify stage:
 *  1. The stubs ARE the production declarations: for each verified surface,
 *     the advertised names, descriptions and JSON schemas deep-equal what the
 *     surface's production server registers under the same exposure.
 *  2. A verify turn executes nothing: with the DB, executeTool, the agent
 *     command queue and fetch trapped, every stub (and a whole verify turn)
 *     runs without touching any of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const trap = vi.hoisted(() => {
  const touched: string[] = [];
  const fn = (name: string) => (..._args: unknown[]) => {
    touched.push(name);
    throw new Error(`trapped: ${name}`);
  };
  return { touched, fn };
});

vi.mock('../../db', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const db = new Proxy({}, { get: (_t, prop) => { trap.touched.push(`db.${String(prop)}`); throw new Error(`trapped: db.${String(prop)}`); } });
  const trapped: Record<string, unknown> = { ...actual, db };
  for (const key of ['withDbAccessContext', 'withSystemDbAccessContext', 'runOutsideDbContext', 'withDbTransaction']) {
    if (key in actual) trapped[key] = trap.fn(key);
  }
  return trapped;
});
vi.mock('../aiTools', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), executeTool: trap.fn('executeTool') }));
vi.mock('../commandQueue', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return Object.fromEntries(Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? trap.fn(`commandQueue.${k}`) : v]));
});

import { breezeServerTools, chatToolDomain, listChatSurfaceToolNames } from '../aiAgentSdkTools';
import { applyRunToolProfile } from '../aiAgents/runToolProfile';
import { buildOutcomeSdkTools } from '../aiAgents/outcomeTools';
import { finalizeSessionToolExposure } from '../aiModels/sessionToolExposure';
import type { ToolProfileFacts } from '../aiModels/toolExposure';
import { scriptBuilderServerTools } from '../scriptBuilderTools';
import { advertisedTool } from './toolCapture/advertisedSchema';
import { CAPTURE_SURFACES } from './toolCapture/surfaces';
import { runSurfaceTurn, stubTools, type SurfaceTurnPlan, type SurfaceTurnSdk } from './surfaceTurnHarness';
import { SURFACE_TURN_CAPTURE_SURFACE, SURFACE_TURN_SURFACES, planSurfaceTurn, type SurfaceTurnSurface } from './surfaceTurnStubs';

const deny = (): never => { throw new Error('production handler'); };
const facts = (toolProfile: ToolProfileFacts['toolProfile']): ToolProfileFacts => ({ toolProfile, toolAllowlist: null, effectiveWindow: null, transport: 'gateway' });

function planned(surface: SurfaceTurnSurface, f: ToolProfileFacts): SurfaceTurnPlan {
  const result = planSurfaceTurn(surface, f);
  if (result.kind !== 'planned') throw new Error(`${surface} refused: ${result.message}`);
  return result.plan;
}

/** What the surface's production server registers under these facts, derived from the production entry points. */
function productionTools(surface: SurfaceTurnSurface, f: ToolProfileFacts) {
  const capture = CAPTURE_SURFACES[SURFACE_TURN_CAPTURE_SURFACE[surface]];
  if (surface === 'ai_agents') {
    const applied = applyRunToolProfile({
      run: { profile: capture.agentProfile! }, facts: f, exposedNames: [...capture.allowedTools], onlyTools: capture.onlyTools,
      flowToolNames: [], offeringId: null, domainOf: chatToolDomain,
    });
    return breezeServerTools(deny, undefined, undefined, undefined, buildOutcomeSdkTools(capture.outcomeTools ?? []), {
      ...(applied.onlyTools ? { onlyTools: applied.onlyTools } : {}),
      ...(applied.exposure.names ? { toolExposure: applied.exposure } : {}),
    });
  }
  const session = finalizeSessionToolExposure({
    surface, facts: f,
    allowedTools: surface === 'chat' ? undefined : capture.allowedTools,
    registryNames: listChatSurfaceToolNames,
    breezeServer: surface !== 'script_builder',
    domainOf: chatToolDomain, extraTools: [],
  });
  if (surface === 'script_builder') return scriptBuilderServerTools(deny as never, undefined, undefined, () => ({ toolExposure: session.exposure }));
  return breezeServerTools(deny, undefined, undefined, undefined, [], {
    ...(surface === 'chat' ? (session.onlyTools ? { onlyTools: session.onlyTools } : {}) : { onlyTools: capture.onlyTools! }),
    ...(session.exposure.names ? { toolExposure: session.exposure } : {}),
  });
}

const CASES: Array<[SurfaceTurnSurface, ToolProfileFacts['toolProfile']]> = [
  ['chat', 'full'], ['chat', 'minimal'], ['chat', 'standard'],
  ['helper', 'full'], ['helper', 'minimal'],
  ['script_builder', 'full'], ['script_builder', 'standard'],
  ['ai_agents', 'full'], ['ai_agents', 'minimal'],
];

describe('surface_turn stubs are the production declarations', () => {
  it('verifies exactly the four tool surfaces it can build (Office is not verified in v1)', () => {
    expect([...SURFACE_TURN_SURFACES]).toEqual(['chat', 'helper', 'script_builder', 'ai_agents']);
  });

  it.each(CASES)('%s × %s: names, descriptions and JSON schemas deep-equal', (surface, profile) => {
    const f = facts(profile);
    const plan = planned(surface, f);
    const stubs = stubTools(plan, 'BRZ-X', () => {});
    const prod = productionTools(surface, f);
    expect(prod.length).toBeGreaterThan(0);
    const advertised = (tools: Array<Parameters<typeof advertisedTool>[1]>) => tools.map((t) => advertisedTool(plan.mcpServerName, t));
    expect(advertised(stubs)).toEqual(advertised(prod));
    expect(stubs.map((s) => s.handler)).not.toContain(prod[0]!.handler);
    // The target is one of the stubs and allowed.
    expect(stubs.map((s) => s.name)).toContain(plan.targetTool);
    expect(plan.allowedTools).toContain(`mcp__${plan.mcpServerName}__${plan.targetTool}`);
  });

  it('a constrained exposure is carried: chat minimal advertises the curated set plus the floor, with its fingerprint', () => {
    const plan = planned('chat', facts('minimal'));
    expect(plan.profile).toBe('minimal');
    expect(plan.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.tools.map((t) => t.name)).toContain('set_device_context');
    expect(plan.tools.length).toBeLessThan(20);
    expect(planned('chat', facts('full')).fingerprint).toBe('full');
  });

  it('a surface that would refuse the profile is not planned (the session refuses it up front anyway)', () => {
    expect(planSurfaceTurn('script_builder', facts('minimal'))).toMatchObject({ kind: 'refused', reason: 'tool_profile_underpowered' });
    expect(planSurfaceTurn('chat', { ...facts('auto'), effectiveWindow: 4096 })).toMatchObject({ kind: 'refused', reason: 'context_window_too_small' });
  });
});

describe('a verify turn executes nothing', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    trap.touched.length = 0;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { trap.touched.push('fetch'); throw new Error('trapped: fetch'); });
  });
  afterEach(() => { fetchSpy.mockRestore(); });

  it.each(CASES)('%s × %s: every stub, valid or invalid input, never throws and touches nothing', async (surface, profile) => {
    const plan = planned(surface, facts(profile));
    const calls: unknown[] = [];
    for (const stub of stubTools(plan, 'BRZ-X', (c) => calls.push(c))) {
      await expect(stub.handler({}, {})).resolves.toHaveProperty('content');
      await expect(stub.handler({ deviceId: 'not-a-uuid', limit: 'x', action: 42 }, {})).resolves.toHaveProperty('content');
    }
    expect(calls.length).toBe(plan.tools.length * 2);
    expect(trap.touched).toEqual([]);
  });

  it('control: the trap fires when a production handler is reached', async () => {
    const capture = CAPTURE_SURFACES.chat;
    const tools = breezeServerTools(() => ({ user: { id: 'u' } }) as never, undefined, undefined, undefined, [], { onlyTools: new Set(['query_devices']) });
    void capture;
    await tools[0]!.handler({}, {}).catch(() => undefined);
    expect(trap.touched.length).toBeGreaterThan(0);
  });

  it('a whole verify turn (fake SDK child calling the target with valid input) passes and touches nothing', async () => {
    for (const surface of SURFACE_TURN_SURFACES) {
      const plan = planned(surface, facts('full'));
      const sdk: SurfaceTurnSdk = {
        createSdkMcpServer: (config) => ({ tools: config.tools }),
        query: ({ options }) => (async function* run() {
          const server = (options.mcpServers as Record<string, { tools: Array<{ name: string; handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> }>)[plan.mcpServerName]!;
          const target = server.tools.find((t) => t.name === plan.targetTool)!;
          const out = await target.handler(validInputFor(plan.targetTool), {});
          const code = (JSON.parse(out.content[0]!.text) as { verification_code?: string }).verification_code ?? 'none';
          yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__${plan.mcpServerName}__${plan.targetTool}` }], usage: { input_tokens: 10 } } };
          yield { type: 'result', subtype: 'success', is_error: false, result: code };
        })(),
      };
      const result = await runSurfaceTurn(
        { plan, wireModel: 'm', childEnv: {}, deadlineMs: 5_000 },
        { sdk, isolatedCwd: async () => null },
      );
      expect({ surface, outcome: result.outcome, detail: result.detail }).toEqual({ surface, outcome: 'passed', detail: expect.any(String) });
    }
    expect(trap.touched).toEqual([]);
  });
});

function validInputFor(tool: string): Record<string, unknown> {
  if (tool === 'get_device_details') return { deviceId: '00000000-0000-4000-8000-000000000001' };
  return {};
}
