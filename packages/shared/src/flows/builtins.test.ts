import { describe, it, expect } from 'vitest';
import { FLOW_BUILTIN_STEPS, FLOW_LATER_BUILTINS, isFlowBuiltin, legacyConditionSchema } from './builtins';

describe('flow builtins', () => {
  it('wait bounds minutes', () => {
    const s = FLOW_BUILTIN_STEPS.wait.inputSchema;
    expect(s.safeParse({ minutes: 5 }).success).toBe(true);
    expect(s.safeParse({ minutes: 1441 }).success).toBe(false);
    expect(s.safeParse({ minutes: 0 }).success).toBe(false);
    expect(s.safeParse({ minutes: 1.5 }).success).toBe(false);
    expect(s.safeParse({ minutes: 1, x: 1 }).success).toBe(false);
  });

  it('set requires 1..20 named values', () => {
    const s = FLOW_BUILTIN_STEPS.set.inputSchema;
    expect(s.safeParse({ values: { a: '{{x}}' } }).success).toBe(true);
    expect(s.safeParse({ values: {} }).success).toBe(false);
    expect(s.safeParse({ values: { '1bad': 1 } }).success).toBe(false);
    expect(s.safeParse({ values: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1])) }).success).toBe(false);
  });

  it('tiers and guards', () => {
    expect(FLOW_BUILTIN_STEPS.wait.tierFor({ minutes: 1 })).toBe(1);
    expect(FLOW_BUILTIN_STEPS.set.tierFor({ values: { a: 1 } })).toBe(1);
    expect(isFlowBuiltin('wait')).toBe(true);
    expect(isFlowBuiltin('notify')).toBe(true);
    expect(isFlowBuiltin('toString')).toBe(false);
    expect([...FLOW_LATER_BUILTINS]).toEqual([]);
    expect(Object.keys(FLOW_BUILTIN_STEPS).sort()).toEqual([
      'ai', 'create_alert', 'http_request', 'notify', 'resolve_targets', 'run_script_on_targets', 'set', 'wait',
    ]);
    for (const n of Object.keys(FLOW_BUILTIN_STEPS)) expect(n).not.toContain('__');
  });

  it('http_request GET is tier 2 and POST tier 3', () => {
    const h = FLOW_BUILTIN_STEPS.http_request;
    expect(h.maxTier).toBe(3);
    expect(h.tierFor({ method: 'GET', url: 'https://api.example.com/x' })).toBe(2);
    expect(h.tierFor({ method: 'HEAD', url: 'https://api.example.com/x' })).toBe(2);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(h.tierFor({ method: m, url: 'https://api.example.com/x' })).toBe(3);
    // A templated or unparseable method resolves to the ceiling (fail closed).
    expect(h.tierFor({ method: '{{inputs.m}}', url: 'https://api.example.com/x' })).toBe(3);
    expect(h.tierFor(null)).toBe(3);
    // Anonymous only (Decision 12): no credential field exists.
    expect(h.inputSchema.safeParse({ method: 'GET', url: 'https://api.example.com/x', credentialId: 'x' }).success).toBe(false);
    expect(h.inputSchema.safeParse({ method: 'TRACE', url: 'https://api.example.com/x' }).success).toBe(false);
  });

  it('notify is tier 2', () => {
    const n = FLOW_BUILTIN_STEPS.notify;
    expect(n.tierFor({})).toBe(2);
    expect(n.maxTier).toBe(2);
    const ok = n.inputSchema.safeParse({ channelId: '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e', title: 't', message: 'm' });
    expect(ok.success && ok.data.severity).toBe('info');
    expect(n.inputSchema.safeParse({ channelId: 'x', title: 't', message: 'm' }).success).toBe(false);
    expect(n.inputSchema.safeParse({ channelId: '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e', title: 't', message: 'm', severity: 'high' }).success).toBe(false);
  });

  it('ai is tier 1', () => {
    const a = FLOW_BUILTIN_STEPS.ai;
    expect(a.tierFor({})).toBe(1);
    expect(a.maxTier).toBe(1);
    const ok = a.inputSchema.safeParse({ prompt: 'p', output: { type: 'object' } });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.tools).toEqual([]);
      expect(ok.data.maxTurns).toBe(4);
      expect(ok.data.maxOutputTokens).toBe(1024);
    }
    expect(a.inputSchema.safeParse({ prompt: 'p', output: { type: 'object' }, maxTurns: 9 }).success).toBe(false);
    expect(a.inputSchema.safeParse({ prompt: 'p', output: { type: 'object' }, maxOutputTokens: 255 }).success).toBe(false);
  });

  it("every builtin's tierFor ≤ maxTier", () => {
    const probes: unknown[] = [null, {}, { method: 'GET' }, { method: 'POST' }, { method: 'get' }, 'x', 42];
    for (const entry of Object.values(FLOW_BUILTIN_STEPS)) {
      for (const p of probes) expect(entry.tierFor(p)).toBeLessThanOrEqual(entry.maxTier);
    }
  });

  it('ai with 21 tools is invalid', () => {
    const tools = (n: number) => Array.from({ length: n }, (_, i) => `get_thing_${i}`);
    expect(FLOW_BUILTIN_STEPS.ai.inputSchema.safeParse({ prompt: 'p', output: {}, tools: tools(20) }).success).toBe(true);
    expect(FLOW_BUILTIN_STEPS.ai.inputSchema.safeParse({ prompt: 'p', output: {}, tools: tools(21) }).success).toBe(false);
  });
});

describe('W6 fleet built-ins (#5221)', () => {
  const SCRIPT = '7d1c3a5e-2b4f-4c6a-9e8d-1f2a3b4c5d6e';
  const GROUP = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
  const run = FLOW_BUILTIN_STEPS.run_script_on_targets;

  it('run_script_on_targets requires exactly one selector', () => {
    const parse = (sel: Record<string, unknown>) => run.inputSchema.safeParse({ scriptId: SCRIPT, ...sel });
    expect(parse({}).success).toBe(false);
    expect(parse({ target: { type: 'groups', groupIds: [GROUP] } }).success).toBe(true);
    expect(parse({ conditions: [] }).success).toBe(true);
    expect(parse({ deviceIds: ['{{trigger.device.id}}'] }).success).toBe(true);
    expect(parse({ fromStep: { stepId: 'a0_run_script', set: 'succeeded' } }).success).toBe(true);
    expect(parse({ target: { type: 'all' }, deviceIds: [GROUP] }).success).toBe(false);
    expect(parse({ conditions: [], fromStep: { stepId: 'a0', set: 'dispatched' } }).success).toBe(false);
    expect(parse({ deviceIds: Array.from({ length: 501 }, () => GROUP) }).success).toBe(false);
    const ok = parse({ conditions: [] });
    expect(ok.success && ok.data.whenOffline).toBe('queue');
  });

  it('run_script_on_targets refuses runAs elevated', () => {
    expect(run.inputSchema.safeParse({ scriptId: SCRIPT, conditions: [], runAs: 'elevated' }).success).toBe(false);
    expect(run.inputSchema.safeParse({ scriptId: SCRIPT, conditions: [], runAs: 'user' }).success).toBe(true);
    expect(run.inputSchema.safeParse({ scriptId: SCRIPT, conditions: [], runAs: 'system' }).success).toBe(true);
  });

  it('fromStep set must be succeeded or dispatched', () => {
    const parse = (set: string) => run.inputSchema.safeParse({ scriptId: SCRIPT, fromStep: { stepId: 'a0_run_script', set } });
    expect(parse('succeeded').success).toBe(true);
    expect(parse('dispatched').success).toBe(true);
    expect(parse('failed').success).toBe(false);
    expect(run.inputSchema.safeParse({ scriptId: SCRIPT, fromStep: { stepId: 'Bad Id', set: 'succeeded' } }).success).toBe(false);
  });

  it('resolve_targets is tier 1, create_alert tier 2, run_script_on_targets tier 3', () => {
    expect(FLOW_BUILTIN_STEPS.resolve_targets.maxTier).toBe(1);
    expect(FLOW_BUILTIN_STEPS.resolve_targets.tierFor({})).toBe(1);
    expect(FLOW_BUILTIN_STEPS.create_alert.maxTier).toBe(2);
    expect(FLOW_BUILTIN_STEPS.create_alert.tierFor({})).toBe(2);
    expect(run.maxTier).toBe(3);
    for (const p of [null, {}, { scriptId: SCRIPT, conditions: [] }]) expect(run.tierFor(p)).toBe(3);
  });

  it('resolve_targets takes exactly one of target or conditions', () => {
    const r = FLOW_BUILTIN_STEPS.resolve_targets.inputSchema;
    expect(r.safeParse({}).success).toBe(false);
    expect(r.safeParse({ target: { type: 'all' } }).success).toBe(true);
    expect(r.safeParse({ conditions: [{ type: 'os', value: 'windows' }] }).success).toBe(true);
    expect(r.safeParse({ target: { type: 'all' }, conditions: [] }).success).toBe(false);
    expect(r.safeParse({ conditions: Array.from({ length: 51 }, () => ({ type: 'os', value: 'linux' })) }).success).toBe(false);
  });

  it('unknown legacy condition type is invalid', () => {
    const parse = (c: unknown) => legacyConditionSchema.safeParse(c);
    const ok = parse({ type: 'tag', value: 'prod' });
    expect(ok.success && ok.data.operator).toBe('is');
    expect(parse({ type: 'hostname', value: 'x' }).success).toBe(false);
    expect(parse({ type: 'os', operator: 'matches', value: 'x' }).success).toBe(false);
    expect(parse({ type: 'os', value: '' }).success).toBe(false);
    expect(parse({ type: 'os', value: 'x', extra: 1 }).success).toBe(false);
  });

  it('create_alert input', () => {
    const c = FLOW_BUILTIN_STEPS.create_alert.inputSchema;
    expect(c.safeParse({ deviceId: '{{item.id}}', severity: 'high', message: 'm' }).success).toBe(true);
    expect(c.safeParse({ deviceId: GROUP, severity: 'urgent', message: 'm' }).success).toBe(false);
    expect(c.safeParse({ deviceId: GROUP, severity: 'low', message: '' }).success).toBe(false);
    expect(c.safeParse({ deviceId: GROUP, severity: 'low', message: 'm', title: 'x'.repeat(201) }).success).toBe(false);
  });
});
