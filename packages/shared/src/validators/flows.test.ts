import { describe, it, expect } from 'vitest';
import {
  flowDocumentV1Schema,
  FLOW_LIMITS,
  isValidFlowSlug,
  slugifyFlowName,
  FLOW_SLUG_RE,
  FLOW_STEP_ID_RE,
} from './flows';

const example = () => ({
  version: 1,
  name: 'Disk cleanup with escalation',
  description: 'x',
  trigger: { type: 'event', event: 'alert.triggered', filter: { alertType: 'disk_space', deviceRole: 'server' } },
  inputs: [{ name: 'ticketBoard', type: 'string', required: false, description: 'board' }],
  steps: [
    { id: 'cleanup', tool: 'run_script', input: { scriptId: '8b2c', deviceIds: ['{{trigger.device.id}}'] }, approval: 'pre_approved', onFailure: 'stop', timeoutSec: 900 },
    { id: 'wait', tool: 'wait', input: { minutes: 5 } },
    { id: 'recheck', tool: 'get_device_metrics', input: { deviceId: '{{trigger.device.id}}', metric: 'disk_free_pct' } },
    { id: 'ticket', when: 'steps.recheck.output.value < 10', tool: 'halo__create_ticket', input: { clientId: '{{trigger.org.externalIds.halo}}', summary: 's' } },
    { id: 'resolve', when: 'steps.recheck.output.value >= 10', tool: 'resolve_alert', input: { alertId: '{{trigger.alert.id}}' } },
  ],
});

describe('flowDocumentV1Schema', () => {
  it('parses the spec example and applies defaults', () => {
    const r = flowDocumentV1Schema.safeParse(example());
    expect(r.success).toBe(true);
    if (!r.success) return;
    const wait = r.data.steps[1]!;
    expect(wait.approval).toBe('default');
    expect(wait.onFailure).toBe('stop');
    expect(wait.timeoutSec).toBe(300);
    expect(r.data.steps[0]!.timeoutSec).toBe(900);
  });

  it('exposes limits', () => {
    expect(FLOW_LIMITS.maxSteps).toBe(50);
    expect(FLOW_LIMITS.maxDocumentBytes).toBe(262_144);
  });

  const bad: Array<[string, (d: any) => void]> = [
    ['51 steps', (d) => { d.steps = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, tool: 'wait', input: { minutes: 1 } })); }],
    ['forEach.as row', (d) => { d.steps[1].forEach = { items: 'inputs.x', as: 'row' }; }],
    ['maxItems 501', (d) => { d.steps[1].forEach = { items: 'inputs.x', maxItems: 501 }; }],
    ['concurrency 11', (d) => { d.steps[1].forEach = { items: 'inputs.x', concurrency: 11 }; }],
    ['timeoutSec 3601', (d) => { d.steps[1].timeoutSec = 3601; }],
    ['step id Cleanup', (d) => { d.steps[1].id = 'Cleanup'; }],
    ['step id 1x', (d) => { d.steps[1].id = '1x'; }],
    ['unknown top-level key', (d) => { d.foo = 1; }],
    ['version 2', (d) => { d.version = 2; }],
    ['bad cron', (d) => { d.trigger = { type: 'schedule', cron: '61 * * * *', timezone: 'UTC' }; }],
    ['unknown step key', (d) => { d.steps[1].extra = 1; }],
  ];
  it.each(bad)('rejects %s', (_n, mutate) => {
    const d = example();
    mutate(d);
    expect(flowDocumentV1Schema.safeParse(d).success).toBe(false);
  });

  it('accepts a valid schedule trigger and forEach defaults', () => {
    const d: any = example();
    d.trigger = { type: 'schedule', cron: '0 3 * * *', timezone: 'UTC' };
    d.steps[1].forEach = { items: 'inputs.x' };
    const r = flowDocumentV1Schema.safeParse(d);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.steps[1]!.forEach).toEqual({ items: 'inputs.x', as: 'item', maxItems: 100, concurrency: 1 });
  });

  it('accepts webhook and manual triggers', () => {
    for (const t of [{ type: 'webhook' }, { type: 'manual' }]) {
      const d: any = example();
      d.trigger = t;
      expect(flowDocumentV1Schema.safeParse(d).success).toBe(true);
    }
  });

  it('rejects event filter with >20 keys or non-scalar values', () => {
    const d: any = example();
    d.trigger.filter = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]));
    expect(flowDocumentV1Schema.safeParse(d).success).toBe(false);
    const e: any = example();
    e.trigger.filter = { a: { b: 1 } };
    expect(flowDocumentV1Schema.safeParse(e).success).toBe(false);
  });
});

describe('slugs', () => {
  it('isValidFlowSlug', () => {
    expect(isValidFlowSlug('disk_cleanup')).toBe(true);
    expect(isValidFlowSlug('a__b')).toBe(false);
    expect(isValidFlowSlug('a')).toBe(false);
    expect(isValidFlowSlug('a' + 'b'.repeat(48))).toBe(false);
    expect(isValidFlowSlug('a' + 'b'.repeat(47))).toBe(true);
    expect(FLOW_SLUG_RE.test('ab')).toBe(true);
    expect(FLOW_STEP_ID_RE.test('a')).toBe(true);
  });
  it('slugifyFlowName', () => {
    expect(slugifyFlowName('Disk Cleanup — Escalation!')).toBe('disk_cleanup_escalation');
    expect(slugifyFlowName('42 things')).toBe('f_42_things');
    expect(slugifyFlowName('a__b')).not.toContain('__');
    expect(isValidFlowSlug(slugifyFlowName('x'.repeat(100)))).toBe(true);
    expect(isValidFlowSlug(slugifyFlowName('!!!'))).toBe(true);
    expect(isValidFlowSlug(slugifyFlowName('a'))).toBe(true);
  });
});
