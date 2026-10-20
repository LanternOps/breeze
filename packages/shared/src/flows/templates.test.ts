import { describe, it, expect } from 'vitest';
import { extractTemplates, renderTemplates, templatedPointers, TEMPLATE_RE } from './templates';

const scope = {
  trigger: { device: { id: 'd1', count: 7, tags: ['a', 'b'], meta: { k: 1 } } },
  inputs: { n: 5, nul: null },
};

describe('renderTemplates', () => {
  it('exact template keeps its type', () => {
    expect(renderTemplates('{{trigger.device.count}}', scope)).toEqual({ ok: true, value: 7 });
    expect(renderTemplates('{{ trigger.device.tags }}', scope)).toEqual({ ok: true, value: ['a', 'b'] });
    expect(renderTemplates('{{inputs.nul}}', scope)).toEqual({ ok: true, value: null });
  });
  it('interpolated templates stringify', () => {
    expect(renderTemplates('n={{inputs.n}} id={{trigger.device.id}}', scope)).toEqual({ ok: true, value: 'n=5 id=d1' });
    expect(renderTemplates('t={{trigger.device.tags}} m={{trigger.device.meta}}', scope)).toEqual({
      ok: true, value: 't=["a","b"] m={"k":1}',
    });
  });
  it('recurses through objects and arrays', () => {
    const r = renderTemplates({ a: ['{{inputs.n}}', 'x{{trigger.device.id}}'], b: { c: '{{trigger.device.id}}' }, d: 3, e: null, f: true }, scope);
    expect(r).toEqual({ ok: true, value: { a: [5, 'xd1'], b: { c: 'd1' }, d: 3, e: null, f: true } });
  });
  it('missing path renders null / empty string', () => {
    expect(renderTemplates('{{trigger.nope}}', scope)).toEqual({ ok: true, value: null });
    expect(renderTemplates('a{{trigger.nope}}b{{inputs.nul}}c', scope)).toEqual({ ok: true, value: 'abc' });
  });
  it('strings without templates pass through', () => {
    expect(renderTemplates('plain', scope)).toEqual({ ok: true, value: 'plain' });
  });
  it('rejects too-large output', () => {
    const big = 'x'.repeat(300 * 1024);
    expect(renderTemplates('{{inputs.big}}', { inputs: { big } })).toEqual({ ok: false, error: 'render_too_large' });
    expect(renderTemplates({ a: 'pre {{inputs.big}}' }, { inputs: { big } })).toMatchObject({ ok: false, error: 'render_too_large' });
  });
  it('reports template parse errors with a pointer', () => {
    expect(renderTemplates({ a: ['ok', '{{ }}'] }, scope)).toEqual({ ok: false, error: 'template_parse_error', pointer: '/a/1' });
    expect(renderTemplates('{{unknown.x}}', scope)).toMatchObject({ ok: false, error: 'template_parse_error', pointer: '' });
    expect(renderTemplates('oops {{ trigger.x', scope)).toMatchObject({ ok: false, error: 'template_parse_error' });
  });
  it('uses own properties only and keeps __proto__ keys as data', () => {
    const input = JSON.parse('{"__proto__": "{{inputs.n}}"}');
    const r = renderTemplates(input, scope);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
      expect(Object.hasOwn(r.value as object, '__proto__')).toBe(true);
    }
  });
});

describe('extractTemplates', () => {
  it('lists refs with pointers and exactness', () => {
    const { refs, errors } = extractTemplates({ deviceIds: ['{{trigger.device.id}}', 'x'], s: 'a {{ inputs.n }} b', 'a/b': { 'c~d': '{{now}}' } });
    expect(errors).toEqual([]);
    expect(refs.map((r) => [r.pointer, r.exact, r.path.root])).toEqual([
      ['/deviceIds/0', true, 'trigger'],
      ['/s', false, 'inputs'],
      ['/a~1b/c~0d', true, 'now'],
    ]);
  });
  it('collects errors, including unterminated and nested braces', () => {
    const { refs, errors } = extractTemplates({ a: '{{ }}', b: '{{ trigger.x', c: '{{ a {b} }}', d: '{{trigger.ok}}' });
    expect(refs.map((r) => r.pointer)).toEqual(['/d']);
    expect(errors.map((e) => e.pointer).sort()).toEqual(['/a', '/b', '/c']);
  });
  it('handles very deep input without recursing', () => {
    let v: unknown = '{{inputs.n}}';
    for (let i = 0; i < 50_000; i++) v = { a: v };
    expect(() => extractTemplates(v)).not.toThrow();
    expect(extractTemplates(v).refs).toHaveLength(1);
  });
  it('TEMPLATE_RE matches template bodies', () => {
    const m = [...'a {{ x.y }} b'.matchAll(TEMPLATE_RE)];
    expect(m[0]![1]).toBe('x.y');
  });
});

describe('templatedPointers', () => {
  it('returns pointers of string leaves containing {{', () => {
    expect(templatedPointers({ a: ['{{x}}', 'y'] })).toEqual(new Set(['/a/0']));
    expect(templatedPointers({ a: 'broken {{', b: 1 })).toEqual(new Set(['/a']));
    expect(templatedPointers('{{x}}')).toEqual(new Set(['']));
    expect(templatedPointers({})).toEqual(new Set());
  });
});
