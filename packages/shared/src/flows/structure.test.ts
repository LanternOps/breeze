import { describe, it, expect } from 'vitest';
import { checkFlowStructure } from './structure';
import { flowDocumentV1Schema, type FlowDocumentV1 } from '../validators/flows';

function doc(over: Record<string, unknown> = {}, steps?: unknown[]): FlowDocumentV1 {
  return flowDocumentV1Schema.parse({
    version: 1,
    name: 'T',
    trigger: { type: 'manual' },
    inputs: [{ name: 'board', type: 'string' }],
    steps: steps ?? [{ id: 'a', tool: 'wait', input: { minutes: 1 } }],
    ...over,
  });
}

const codes = (d: FlowDocumentV1) => checkFlowStructure(d).map((i) => i.code);

describe('checkFlowStructure', () => {
  it('passes the spec example with zero issues', () => {
    const d = flowDocumentV1Schema.parse({
      version: 1,
      name: 'Disk cleanup with escalation',
      trigger: { type: 'event', event: 'alert.triggered', filter: { alertType: 'disk_space' } },
      inputs: [{ name: 'ticketBoard', type: 'string', required: false }],
      steps: [
        { id: 'cleanup', tool: 'run_script', input: { scriptId: '8b2c', deviceIds: ['{{trigger.device.id}}'] }, approval: 'pre_approved', timeoutSec: 900 },
        { id: 'wait', tool: 'wait', input: { minutes: 5 } },
        { id: 'recheck', tool: 'get_device_metrics', input: { deviceId: '{{trigger.device.id}}', metric: 'disk_free_pct' } },
        { id: 'ticket', when: 'steps.recheck.output.value < 10', tool: 'halo__create_ticket', input: { clientId: '{{trigger.org.externalIds.halo}}', summary: 'Disk low on {{trigger.device.hostname}} {{inputs.ticketBoard}}' } },
        { id: 'resolve', when: 'steps.recheck.output.value >= 10 && steps.cleanup.status == \'ok\'', tool: 'resolve_alert', input: { alertId: '{{trigger.alert.id}}' } },
      ],
    });
    expect(checkFlowStructure(d)).toEqual([]);
  });

  it('flags forward and self references', () => {
    const d = doc({}, [
      { id: 'a', tool: 'x', input: { v: '{{steps.b.output.x}}' } },
      { id: 'b', tool: 'x', when: 'steps.b.status == null' },
    ]);
    const issues = checkFlowStructure(d);
    expect(issues.map((i) => i.code)).toEqual(['forward_reference', 'forward_reference']);
    expect(issues[0]).toMatchObject({ severity: 'error', stepId: 'a' });
  });

  it('flags unknown step references', () => {
    const d = doc({}, [{ id: 'a', tool: 'x', input: { v: '{{steps.zzz.output}}' } }]);
    expect(codes(d)).toEqual(['unknown_step_reference']);
  });

  it('allows references to earlier steps in forEach.items and when', () => {
    const d = doc({}, [
      { id: 'a', tool: 'x' },
      { id: 'b', tool: 'x', when: 'steps.a.status == "ok"', forEach: { items: 'steps.a.output.list' }, input: { v: '{{item.id}}' } },
    ]);
    expect(checkFlowStructure(d)).toEqual([]);
  });

  it('flags item outside forEach', () => {
    const d = doc({}, [{ id: 'a', tool: 'x', input: { v: '{{item.x}}' } }, { id: 'b', tool: 'x', when: 'item.x == 1' }]);
    expect(codes(d)).toEqual(['item_outside_foreach', 'item_outside_foreach']);
  });

  it('allows item in a forEach step input and when, but not in its own forEach.items', () => {
    const ok = doc({}, [{ id: 'a', tool: 'x', input: { v: '{{item.x}}' }, when: 'item.y == 1', forEach: { items: 'trigger.list' } }]);
    expect(codes(ok)).toEqual([]);
    const bad = doc({}, [{ id: 'a', tool: 'x', forEach: { items: 'item.children' } }]);
    expect(codes(bad)).toEqual(['item_outside_foreach']);
  });

  it('flags undeclared inputs', () => {
    const d = doc({}, [{ id: 'a', tool: 'x', input: { v: '{{inputs.board}} {{inputs.other}}' }, when: 'inputs.nope == 1' }]);
    const issues = checkFlowStructure(d);
    expect(issues.map((i) => i.code)).toEqual(['undeclared_input', 'undeclared_input']);
    expect(issues[0]!.message).toContain('other');
  });

  it('restricts steps.<id>.<field> to output/status', () => {
    const d = doc({}, [{ id: 'a', tool: 'x' }, { id: 'b', tool: 'x', input: { v: '{{steps.a.result}}', w: '{{steps.a}}' } }]);
    expect(codes(d)).toEqual(['unknown_root', 'unknown_root']);
  });

  it('flags duplicate ids once per duplicate', () => {
    const d = doc({}, [{ id: 'a', tool: 'x' }, { id: 'a', tool: 'x' }, { id: 'a', tool: 'x' }, { id: 'b', tool: 'x' }]);
    expect(codes(d)).toEqual(['duplicate_step_id', 'duplicate_step_id']);
  });

  it('reports expression parse errors with the offset, and template parse errors with the pointer', () => {
    const d = doc({}, [{ id: 'a', tool: 'x', when: '1 ==', input: { z: ['{{ }}'] }, forEach: { items: '(' } }]);
    const issues = checkFlowStructure(d);
    expect(issues.map((i) => i.code).sort()).toEqual(['expr_parse_error', 'expr_parse_error', 'template_parse_error']);
    const t = issues.find((i) => i.code === 'template_parse_error')!;
    expect(t.pointer).toBe('/steps/0/input/z/0');
    expect(issues.find((i) => i.code === 'expr_parse_error')!.pointer).toMatch(/^\/steps\/0\/(when|forEach\/items)$/);
    expect(issues.find((i) => i.code === 'expr_parse_error')!.message).toMatch(/offset \d+/);
  });

  describe('whole-document bounds', () => {
    it('a 300 KB document yields only document_too_large', () => {
      const d = doc({}, [{ id: 'a', tool: 'x', input: { big: 'y'.repeat(300 * 1024), t: '{{steps.zz.output}}' } }]);
      const issues = checkFlowStructure(d);
      expect(issues.map((i) => i.code)).toEqual(['document_too_large']);
    });
    it('multibyte content counts in UTF-8 bytes', () => {
      const d = doc({}, [{ id: 'a', tool: 'x', input: { big: '€'.repeat(100_000) } }]); // 100k chars, 300k bytes
      expect(codes(d)).toEqual(['document_too_large']);
    });
    it('input nested 17 deep is input_too_deep; 16 is fine', () => {
      const nest = (n: number) => { let v: unknown = 'leaf'; for (let i = 0; i < n; i++) v = { a: v }; return v as Record<string, unknown>; };
      expect(codes(doc({}, [{ id: 'a', tool: 'x', input: nest(17) }]))).toEqual(['input_too_deep']);
      expect(codes(doc({}, [{ id: 'a', tool: 'x', input: nest(16) }]))).toEqual([]);
    });
    it('501 templates is too_many_templates; 500 is fine', () => {
      const mk = (n: number) => ({ list: Array.from({ length: n }, () => '{{trigger.x}}') });
      expect(codes(doc({}, [{ id: 'a', tool: 'x', input: mk(501) }]))).toEqual(['too_many_templates']);
      expect(codes(doc({}, [{ id: 'a', tool: 'x', input: mk(500) }]))).toEqual([]);
    });
  });
});
