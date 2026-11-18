import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_SLUG_RE } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';

/**
 * W5 PR C (#5220), Task C1 — flow tool descriptors and the live invocation
 * tier. The read is a queue fake (one result per select); the owner predicate
 * itself is proven on compiled SQL in flowTools.query.test.ts and on a real
 * database in flowToolsRls.integration.test.ts.
 */

const { selects, selectCalls } = vi.hoisted(() => ({ selects: [] as unknown[], selectCalls: { n: 0, inSystem: 0, depth: 0 } }));

vi.mock('../../db', () => {
  function chain() {
    selectCalls.n += 1;
    if (selectCalls.depth > 0) selectCalls.inSystem += 1;
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = selects.shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        if (prop === 'toSQL') return () => ({ sql: '', params: [] });
        return () => proxy;
      },
    });
    return proxy;
  }
  return {
    db: { select: () => chain() },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => unknown) => {
      selectCalls.depth += 1;
      try { return await fn(); } finally { selectCalls.depth -= 1; }
    },
  };
});
vi.mock('../../config/env', async (orig) => ({ ...(await orig<typeof import('../../config/env')>()), flowsEnabled: vi.fn(() => true) }));
vi.mock('../flowValidator', () => {
  class FlowStepPinError extends Error {
    constructor(readonly stepId: string) { super(`pin ${stepId}`); }
  }
  return { stepPinsFor: vi.fn(), FlowStepPinError };
});

import { flowsEnabled } from '../../config/env';
import { FlowStepPinError, stepPinsFor } from '../flowValidator';
import { isToolEnvGatedOff } from '../aiToolEnvGates';
import {
  FLOW_TOOL_PREFIX,
  flowInvocationTier,
  flowToolName,
  isFlowToolName,
  resolveFlowToolForCall,
  resolveFlowTools,
  resolveRunFlowGate,
} from './flowTools';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const PARTNER_A = '22222222-2222-4222-8222-222222222222';
const FLOW_1 = '44444444-4444-4444-8444-444444444444';
const PUB_1 = '55555555-5555-4555-8555-555555555555';

function orgAuth(): AuthContext {
  return { scope: 'organization', orgId: ORG_A, partnerId: PARTNER_A, user: { id: 'u' }, canAccessOrg: (id: string) => id === ORG_A } as unknown as AuthContext;
}
function partnerAuth(): AuthContext {
  return { scope: 'partner', orgId: null, partnerId: PARTNER_A, user: { id: 'u' }, canAccessOrg: (id: string) => id === ORG_A } as unknown as AuthContext;
}

function doc(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    name: 'Triage disk',
    trigger: { type: 'manual' },
    inputs: [{ name: 'deviceId', type: 'uuid', required: true }, { name: 'note', type: 'string' }, { name: 'n', type: 'number' }, { name: 'force', type: 'boolean' }],
    steps: [{ id: 's1', tool: 'list_devices', input: {} }],
    ...over,
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    flowId: FLOW_1,
    orgId: ORG_A,
    flowPartnerId: null,
    ownerPartnerId: PARTNER_A,
    slug: 'triage_disk',
    name: 'Triage disk',
    description: 'Collects disk usage.',
    publicationId: PUB_1,
    publicationSeq: 3,
    effectiveTier: 1,
    definition: doc(),
    lastRunAt: null,
    ...over,
  };
}

function pins(...tiers: Array<1 | 2 | 3>) {
  return tiers.map((tier, i) => ({ stepId: `s${i + 1}`, tool: 'list_devices', source: 'core', tier, approvalScope: null }));
}

beforeEach(() => {
  selects.length = 0;
  selectCalls.n = 0;
  selectCalls.inSystem = 0;
  vi.mocked(flowsEnabled).mockReturnValue(true);
  vi.mocked(stepPinsFor).mockReset();
  vi.mocked(stepPinsFor).mockResolvedValue(pins(1) as never);
});

describe('flow tool names', () => {
  it("isFlowToolName('flow__a_b') true, 'flow__' false, 'flow___x' false", () => {
    expect(FLOW_TOOL_PREFIX).toBe('flow__');
    expect(isFlowToolName('flow__a_b')).toBe(true);
    expect(isFlowToolName('flow__')).toBe(false);
    expect(isFlowToolName('flow___x')).toBe(false);
    expect(isFlowToolName('flow__a__b')).toBe(false);
    expect(isFlowToolName('flow__A')).toBe(false);
    expect(isFlowToolName('hudu__flow__x')).toBe(false);
    expect(isFlowToolName('run_flow')).toBe(false);
    expect(flowToolName('triage_disk')).toBe('flow__triage_disk');
  });

  it('the leaf slug rule is the shared FLOW_SLUG_RE', () => {
    for (const s of ['ab', 'a_1', 'x'.repeat(48), 'a', '1a', 'a'.repeat(49), 'aB']) {
      expect(isFlowToolName(`flow__${s}`)).toBe(FLOW_SLUG_RE.test(s) && !s.includes('__'));
    }
  });

  it('aiToolEnvGates gates flow__ names with FLOWS_ENABLED', () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(isToolEnvGatedOff('flow__triage_disk')).toBe(true);
    vi.mocked(flowsEnabled).mockReturnValue(true);
    expect(isToolEnvGatedOff('flow__triage_disk')).toBe(false);
    // A tenant tool name is not a flow tool and is never gated by the flag.
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(isToolEnvGatedOff('hudu__get_asset')).toBe(false);
  });
});

describe('resolveFlowTools', () => {
  it('the read is BUILT inside the system context (the db proxy binds at build time; built outside, it reads nothing under forced RLS)', async () => {
    selects.push([row()]);
    await resolveFlowTools(orgAuth(), ORG_A);
    selects.push([row()]);
    await resolveFlowToolForCall(orgAuth(), 'flow__triage_disk', ORG_A);
    expect(selectCalls.n).toBe(2);
    expect(selectCalls.inSystem).toBe(2);
  });

  it('org caller sees its org flows and partner-wide flows of its partner', async () => {
    selects.push([row({ lastRunAt: new Date() }), row({ flowId: 'f2', orgId: null, flowPartnerId: PARTNER_A, slug: 'sweep', name: 'Sweep', publicationId: 'p2' })]);
    const tools = await resolveFlowTools(orgAuth(), ORG_A);
    expect(tools.map((t) => t.name)).toEqual(['flow__triage_disk', 'flow__sweep']);
    expect(tools[0]).toMatchObject({ flowId: FLOW_1, publicationId: PUB_1, publicationSeq: 3, partnerWide: false, owner: { orgId: ORG_A, partnerId: PARTNER_A }, revision: `flowpub:${PUB_1}` });
    expect(tools[1]).toMatchObject({ partnerWide: true, owner: { orgId: null, partnerId: PARTNER_A } });
  });

  it('draft, disabled and paused flows are absent (the read asks for enabled live publications only)', async () => {
    // The status predicate is SQL (flowTools.query.test.ts); here a row whose
    // stored definition no longer parses is dropped, never guessed at.
    selects.push([row({ definition: { version: 1 } })]);
    expect(await resolveFlowTools(orgAuth(), ORG_A)).toEqual([]);
  });

  it('schedule-trigger flow is absent', async () => {
    selects.push([row({ definition: doc({ trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } }) })]);
    expect(await resolveFlowTools(orgAuth(), ORG_A)).toEqual([]);
  });

  it('a flow declaring an input named orgId or idempotencyKey is not exposed (reserved tool arguments)', async () => {
    selects.push([row({ definition: doc({ inputs: [{ name: 'orgId', type: 'uuid' }] }) })]);
    expect(await resolveFlowTools(orgAuth(), ORG_A)).toEqual([]);
  });

  it('cap of 20, most recently run first', async () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({
      flowId: `f${i}`, slug: `flow_${String(i).padStart(2, '0')}`, publicationId: `p${i}`,
      lastRunAt: i % 5 === 0 ? null : new Date(Date.UTC(2026, 9, 1, 0, i)),
    }));
    selects.push(rows);
    const tools = await resolveFlowTools(orgAuth(), ORG_A);
    expect(tools).toHaveLength(20);
    expect(tools[0]!.name).toBe('flow__flow_24');
    expect(tools[1]!.name).toBe('flow__flow_23');
    // 20 flows have runs, so the five never-run ones fall past the cap.
    expect(tools.slice(-1)[0]!.name).toBe('flow__flow_01');
    expect(tools.map((t) => t.name)).not.toContain('flow__flow_00');
  });

  it('never-run flows sort after run ones, then by slug', async () => {
    selects.push([
      row({ flowId: 'f1', slug: 'zeta', publicationId: 'p1' }),
      row({ flowId: 'f2', slug: 'alpha', publicationId: 'p2' }),
      row({ flowId: 'f3', slug: 'mid', publicationId: 'p3', lastRunAt: '2026-10-01T00:00:00Z' }),
    ]);
    expect((await resolveFlowTools(orgAuth(), ORG_A)).map((t) => t.name)).toEqual(['flow__mid', 'flow__alpha', 'flow__zeta']);
  });

  it('returns nothing when the flag is off or for system scope, without reading', async () => {
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await resolveFlowTools(orgAuth(), ORG_A)).toEqual([]);
    vi.mocked(flowsEnabled).mockReturnValue(true);
    expect(await resolveFlowTools({ scope: 'system' } as unknown as AuthContext, null)).toEqual([]);
    expect(selectCalls.n).toBe(0);
  });

  it('input schema: declared inputs typed, required from declarations, optional idempotencyKey, no additional properties', async () => {
    selects.push([row()]);
    const [tool] = await resolveFlowTools(orgAuth(), ORG_A);
    const schema = tool!.definition.input_schema as Record<string, any>;
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['deviceId']);
    expect(schema.properties.deviceId).toMatchObject({ type: 'string', format: 'uuid' });
    expect(schema.properties.note).toMatchObject({ type: 'string' });
    expect(schema.properties.n).toMatchObject({ type: 'number' });
    expect(schema.properties.force).toMatchObject({ type: 'boolean' });
    expect(schema.properties.idempotencyKey).toMatchObject({ type: 'string' });
    // An org caller never names the org: a partner-wide flow runs in its own org.
    expect(schema.properties.orgId).toBeUndefined();
  });

  it('partner caller gets an orgId argument on a partner-wide flow only', async () => {
    selects.push([
      row({ flowId: 'f2', orgId: null, flowPartnerId: PARTNER_A, slug: 'sweep', publicationId: 'p2' }),
      row(),
    ]);
    const tools = await resolveFlowTools(partnerAuth(), ORG_A);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect((byName.get('flow__sweep')!.definition.input_schema as any).properties.orgId).toMatchObject({ type: 'string', format: 'uuid' });
    expect((byName.get('flow__triage_disk')!.definition.input_schema as any).properties.orgId).toBeUndefined();
  });

  it('input schema has no undefined types', async () => {
    selects.push([row()]);
    const [tool] = await resolveFlowTools(partnerAuth(), ORG_A);
    const walk = (node: unknown): void => {
      if (node === undefined) throw new Error('undefined node in tool schema');
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === 'type') expect(['object', 'string', 'number', 'boolean', 'integer', 'array']).toContain(v);
          walk(v);
        }
      }
    };
    walk(tool!.definition);
    expect(JSON.parse(JSON.stringify(tool!.definition))).toEqual(tool!.definition);
  });

  it('description is prose, prefixed, single-line and at most 300 chars', async () => {
    selects.push([row({ name: 'Disk\n\ttriage', description: `Line one.\n${'x'.repeat(400)}` })]);
    const [tool] = await resolveFlowTools(orgAuth(), ORG_A);
    expect(tool!.definition.description.startsWith('Flow: Disk triage — Line one.')).toBe(true);
    expect(tool!.definition.description).not.toMatch(/[\n\t]/);
    expect(tool!.definition.description.length).toBeLessThanOrEqual(300);
  });

  it('validate coerces declared inputs and separates orgId / idempotencyKey', async () => {
    selects.push([row({ flowId: 'f2', orgId: null, flowPartnerId: PARTNER_A, slug: 'sweep', publicationId: 'p2' })]);
    const [tool] = await resolveFlowTools(partnerAuth(), ORG_A);
    const ok = tool!.validate({ deviceId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', n: '4', orgId: ORG_A, idempotencyKey: 'k-1' });
    expect(ok).toEqual({ ok: true, value: { inputs: { deviceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', note: null, n: 4, force: null }, orgId: ORG_A, idempotencyKey: 'k-1' } });
    expect(tool!.validate({ note: 'x' })).toMatchObject({ ok: false });
    expect(tool!.validate({ deviceId: ORG_A, bogus: 1 })).toMatchObject({ ok: false });
    expect(tool!.validate({ deviceId: ORG_A, idempotencyKey: 'has space' })).toMatchObject({ ok: false });
    expect(tool!.validate({ deviceId: ORG_A, orgId: 'not-a-uuid' })).toMatchObject({ ok: false });
  });

  it('an org caller passing orgId is refused by validate (the argument does not exist for it)', async () => {
    selects.push([row()]);
    const [tool] = await resolveFlowTools(orgAuth(), ORG_A);
    expect(tool!.validate({ deviceId: ORG_A, orgId: ORG_A })).toMatchObject({ ok: false });
  });
});

describe('flowInvocationTier', () => {
  const owner = { orgId: ORG_A, partnerId: PARTNER_A };

  it('tier never below the recorded effective tier', async () => {
    vi.mocked(stepPinsFor).mockResolvedValue(pins(1) as never);
    expect(await flowInvocationTier({ effectiveTier: 2, definition: doc() }, owner)).toBe(2);
  });

  it('tenant step whose live tier rose raises the invocation tier', async () => {
    vi.mocked(stepPinsFor).mockResolvedValue([
      ...pins(1),
      { stepId: 's2', tool: 'hudu__update', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 't', tenantRevision: 'r2' },
    ] as never);
    expect(await flowInvocationTier({ effectiveTier: 1, definition: doc() }, owner)).toBe(3);
  });

  it('vanished pinned tool makes the tier 3', async () => {
    vi.mocked(stepPinsFor).mockRejectedValue(new FlowStepPinError('s1'));
    expect(await flowInvocationTier({ effectiveTier: 1, definition: doc() }, owner)).toBe(3);
  });

  it('a publication whose document no longer parses is tier 3', async () => {
    expect(await flowInvocationTier({ effectiveTier: 1, definition: { version: 1 } }, owner)).toBe(3);
    expect(stepPinsFor).not.toHaveBeenCalled();
  });

  it('other failures propagate (the caller fails closed)', async () => {
    vi.mocked(stepPinsFor).mockRejectedValue(new Error('db down'));
    await expect(flowInvocationTier({ effectiveTier: 1, definition: doc() }, owner)).rejects.toThrow('db down');
  });
});

describe('resolveFlowToolForCall', () => {
  it('returns the live descriptor with the live tier (the publication used is the live one)', async () => {
    selects.push([row({ publicationId: 'p-new', publicationSeq: 4, effectiveTier: 1 })]);
    vi.mocked(stepPinsFor).mockResolvedValue(pins(1, 2) as never);
    const d = await resolveFlowToolForCall(orgAuth(), 'flow__triage_disk', ORG_A);
    expect(d).toMatchObject({ publicationId: 'p-new', publicationSeq: 4, tier: 2, revision: 'flowpub:p-new' });
  });

  it('null for a non-flow name, an unknown slug, or the flag off', async () => {
    expect(await resolveFlowToolForCall(orgAuth(), 'list_devices', ORG_A)).toBeNull();
    selects.push([]);
    expect(await resolveFlowToolForCall(orgAuth(), 'flow__nope', ORG_A)).toBeNull();
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect(await resolveFlowToolForCall(orgAuth(), 'flow__triage_disk', ORG_A)).toBeNull();
  });
});

describe('resolveRunFlowGate', () => {
  it('resolveRunFlowGate pins the flow and the live publication seq the tier was computed for', async () => {
    selects.push([row({ publicationSeq: 7 })]);
    vi.mocked(stepPinsFor).mockResolvedValue(pins(1) as never);
    expect(await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).toEqual({ tier: 1, flowId: FLOW_1, publicationSeq: 7 });
    selects.push([]);
    expect(await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).toEqual({ tier: 3 });
  });

  it('returns the flow\'s live invocation tier', async () => {
    selects.push([row()]);
    vi.mocked(stepPinsFor).mockResolvedValue(pins(1) as never);
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(1);
  });

  it('resolveRunFlowGate returns tier 3 on any error and when the flag is off', async () => {
    selects.push(new Error('db down'));
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(3);
    selects.push([row()]);
    vi.mocked(stepPinsFor).mockRejectedValue(new Error('boom'));
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(3);
    vi.mocked(flowsEnabled).mockReturnValue(false);
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(3);
  });

  it('3 for a missing flow, a non-uuid id, or a flow that is not manual', async () => {
    selects.push([]);
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(3);
    expect((await resolveRunFlowGate(orgAuth(), { flowId: 'x' })).tier).toBe(3);
    expect((await resolveRunFlowGate(orgAuth(), {})).tier).toBe(3);
    selects.push([row({ definition: doc({ trigger: { type: 'schedule', cron: '0 * * * *', timezone: 'UTC' } }) })]);
    expect((await resolveRunFlowGate(orgAuth(), { flowId: FLOW_1 })).tier).toBe(3);
  });
});
