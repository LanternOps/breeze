import { describe, it, expect } from 'vitest';
import { parseExpr, parsePath, evaluateExpr, isTruthy, EXPR_LIMITS, type FlowScope } from './expr';

function ev(src: string, scope: FlowScope = {}) {
  const p = parseExpr(src);
  if (!p.ok) throw new Error(`parse failed: ${p.error} (${src})`);
  const r = evaluateExpr(p.ast, scope);
  if (!r.ok) throw new Error(`eval failed: ${r.error}`);
  return r.value;
}

describe('literals and operators', () => {
  it.each([
    ['1 == 1', true], ['1 == 2', false], ['"a" == \'a\'', true], ['null == null', true], ['true == true', true],
    ['1 != 2', true], ['1 != 1', false],
    ['1 < 2', true], ['2 < 1', false], ['1 <= 1', true], ['2 <= 1', false],
    ['2 > 1', true], ['1 > 2', false], ['1 >= 1', true], ['0 >= 1', false],
    ['"a" < "b"', true], ['"b" < "a"', false], ['"a" <= "a"', true], ['"b" > "a"', true], ['"a" >= "b"', false],
    ['1 < "2"', false], ['"1" < 2', false],
    ['-1.5 < 0', true],
    ['true && true', true], ['true && false', false], ['false && true', false], ['false && false', false],
    ['true || false', true], ['false || true', true], ['false || false', false], ['true || true', true],
    ['!true', false], ['!false', true], ['!null', true], ['!1', true],
    ['1 && true', false], ['true && 1', false], ['1 || true', true],
    ['"a\\n\\t\\\\\\"\\\'" == "a\\n\\t\\\\\\"\\\'"', true],
  ])('%s => %s', (src, expected) => {
    expect(ev(src)).toBe(expected);
  });

  it('precedence: a || b && c', () => {
    expect(ev('true || false && false')).toBe(true);
    expect(ev('false && false || true')).toBe(true);
    expect(ev('(true || false) && false')).toBe(false);
    expect(ev('1 == 1 && 2 > 1')).toBe(true);
    expect(ev('!1 == 2')).toBe(false); // (!1) == 2 -> true == 2 -> false
    expect(ev('!(1 == 2)')).toBe(true);
    expect(ev("'b' in ['a']" .replace("['a']", 'inputs.l'), { inputs: { l: ['a', 'b'] } })).toBe(true);
  });

  it('short-circuits', () => {
    expect(ev('false && steps.nope.output.x == 1')).toBe(false);
  });
});

describe('null semantics', () => {
  it('missing path equals null', () => {
    expect(ev('steps.x.output.missing == null', { steps: { x: { output: {} } } })).toBe(true);
    expect(ev('steps.x.output.missing == null', {})).toBe(true);
  });
  it('comparisons with null are false', () => {
    expect(ev('null < 1')).toBe(false);
    expect(ev('1 > null')).toBe(false);
    expect(ev('null <= null')).toBe(false);
    expect(ev('null >= null')).toBe(false);
  });
  it('exists tells null from absent', () => {
    expect(ev('exists(inputs.a)', { inputs: { a: null } })).toBe(true);
    expect(ev('exists(inputs.a)', { inputs: {} })).toBe(false);
    expect(ev('exists(inputs.a)', {})).toBe(false);
    expect(ev('exists(inputs.l[1])', { inputs: { l: [1, 2] } })).toBe(true);
    expect(ev('exists(inputs.l[2])', { inputs: { l: [1, 2] } })).toBe(false);
  });
  it('skipped step', () => {
    const scope: FlowScope = { steps: { s: { status: 'skipped', output: null } } };
    expect(ev("steps.s.status == 'skipped'", scope)).toBe(true);
    expect(ev('steps.s.output == null', scope)).toBe(true);
  });
});

describe('strictness', () => {
  it('no coercion, no structural equality', () => {
    expect(ev("1 == '1'")).toBe(false);
    expect(ev('inputs.a == inputs.a', { inputs: { a: [1] } })).toBe(false);
    expect(ev('inputs.a != inputs.a', { inputs: { a: [1] } })).toBe(true);
    expect(ev('inputs.a == inputs.b', { inputs: { a: { x: 1 }, b: { x: 1 } } })).toBe(false);
    expect(ev('inputs.a == null', { inputs: { a: [] } })).toBe(false);
  });
  it('in is array membership only', () => {
    expect(ev("'b' in ['a','b']".replace("['a','b']", 'inputs.l'), { inputs: { l: ['a', 'b'] } })).toBe(true);
    expect(ev("'c' in inputs.l", { inputs: { l: ['a', 'b'] } })).toBe(false);
    expect(ev("'ab' in inputs.s", { inputs: { s: 'abc' } })).toBe(false);
    expect(ev('1 in inputs.l', { inputs: { l: ['1'] } })).toBe(false);
    expect(ev('1 in inputs.l', { inputs: { l: [1] } })).toBe(true);
    expect(ev('null in inputs.l', { inputs: { l: [null] } })).toBe(true);
    expect(ev('1 in null')).toBe(false);
    expect(ev('inputs.l in inputs.m', { inputs: { l: [1], m: [[1]] } })).toBe(false);
  });
});

describe('prototype safety', () => {
  it.each(['steps.a.output.__proto__', 'steps.a.output.constructor', 'steps.a.output.prototype', 'inputs.__proto__.x'])(
    'rejects %s', (src) => {
      expect(parseExpr(src).ok).toBe(false);
      expect(parsePath(src).ok).toBe(false);
    });
  it('only own properties resolve', () => {
    const scope: FlowScope = { trigger: Object.create({ inherited: 1 }) as never };
    expect(ev('trigger.inherited == null', scope)).toBe(true);
    expect(ev('exists(trigger.inherited)', scope)).toBe(false);
    expect(ev('trigger.toString == null', { trigger: {} })).toBe(true);
    expect(ev('inputs.l.length == null', { inputs: { l: [1] } })).toBe(true);
    expect(ev('inputs.s.length == null', { inputs: { s: 'abc' } })).toBe(true);
  });
  it('does not resolve names outside the scope object', () => {
    expect(ev('exists(flow)', {})).toBe(false);
  });
});

describe('paths', () => {
  it('rejects unknown roots', () => {
    expect(parseExpr('foo.bar == 1').ok).toBe(false);
    expect(parseExpr('window.x').ok).toBe(false);
  });
  it('index segments', () => {
    expect(ev('trigger.items[1].id', { trigger: { items: [{ id: 'a' }, { id: 'b' }] } })).toBe('b');
    expect(ev('trigger.items[5].id == null', { trigger: { items: [] } })).toBe(true);
  });
  it('parsePath shapes', () => {
    const r = parsePath('steps.a.output.x[2]');
    expect(r).toEqual({ ok: true, path: { root: 'steps', segments: ['a', 'output', 'x', 2] } });
    expect(parsePath('trigger').ok).toBe(true);
    expect(parsePath('trigger.').ok).toBe(false);
    expect(parsePath('trigger.a b').ok).toBe(false);
    expect(parsePath('trigger.a == 1').ok).toBe(false);
    expect(parsePath('').ok).toBe(false);
    expect(parsePath('1abc').ok).toBe(false);
    expect(parsePath('trigger[-1]').ok).toBe(false);
  });
  it('paths list has every occurrence', () => {
    const r = parseExpr('inputs.a == inputs.a && exists(steps.s.output) || item.x in inputs.l');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.paths.map((p) => `${p.root}:${p.segments.join('.')}`)).toEqual([
      'inputs:a', 'inputs:a', 'steps:s.output', 'item:x', 'inputs:l',
    ]);
  });
});

describe('functions', () => {
  it('length', () => {
    expect(ev("length('héllo') == 5")).toBe(true);
    expect(ev('length(inputs.l)', { inputs: { l: [1, 2, 3] } })).toBe(3);
    expect(ev('length(inputs.o) == null', { inputs: { o: { a: 1 } } })).toBe(true);
    expect(ev('length(null) == null')).toBe(true);
    expect(ev("length('😀😀')")).toBe(2);
  });
  it('lower', () => {
    expect(ev("lower('AbC') == 'abc'")).toBe(true);
    expect(ev('lower(1) == null')).toBe(true);
  });
  it('parse errors', () => {
    expect(parseExpr('exists(1)').ok).toBe(false);
    expect(parseExpr("exists('a')").ok).toBe(false);
    expect(parseExpr('upper(inputs.x)').ok).toBe(false);
    expect(parseExpr('length()').ok).toBe(false);
    expect(parseExpr('length(inputs.a').ok).toBe(false);
  });
});

describe('syntax errors', () => {
  it.each(['', '   ', '1 ==', '== 1', '1 1', '(1', '1)', 'a.b', '"unterminated', "'x\\q'", '1 = 1', '1 & 1', '1 | 1', '@', '1.', '.5', 'true.x'])(
    'rejects %j with an offset', (src) => {
      const r = parseExpr(src);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(typeof r.error).toBe('string');
        expect(r.offset).toBeGreaterThanOrEqual(0);
      }
    });
});

describe('bounds', () => {
  it('33 nested parens is a depth error; 32 is fine', () => {
    const nest = (n: number) => '('.repeat(n) + '1' + ')'.repeat(n);
    const bad = parseExpr(nest(33));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/depth/i);
    expect(parseExpr(nest(32)).ok).toBe(true);
  });
  it('long chains of unary not are depth-limited', () => {
    const r = parseExpr('!'.repeat(40) + 'true');
    expect(r.ok).toBe(false);
  });
  it('2049-char source is rejected', () => {
    const src = '1'.padEnd(EXPR_LIMITS.maxSourceLength + 1, ' ');
    const r = parseExpr(src);
    expect(r.ok).toBe(false);
    expect(parseExpr('1'.padEnd(EXPR_LIMITS.maxSourceLength, ' ')).ok).toBe(true);
  });
  it('a 5001-term || chain never throws', () => {
    const src = Array.from({ length: 5001 }, () => 'a').join(' || ');
    expect(() => parseExpr(src)).not.toThrow();
    const r = parseExpr(src);
    expect(r.ok).toBe(false); // exceeds 2048 chars
  });
  it('a long chain within the source limit evaluates iteratively', () => {
    const src = Array.from({ length: 330 }, () => 'null').join('||'); // ~2k chars, deep left spine
    expect(src.length).toBeLessThanOrEqual(EXPR_LIMITS.maxSourceLength);
    const r = parseExpr(src);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => evaluateExpr(r.ast, {})).not.toThrow();
    expect(evaluateExpr(r.ast, {})).toEqual({ ok: true, value: false });
  });
  it('evaluation budget is enforced with a hand-built huge AST (no stack overflow)', () => {
    let ast: any = { kind: 'lit', value: true };
    for (let i = 0; i < 20_000; i++) ast = { kind: 'bin', op: '||', left: ast, right: { kind: 'lit', value: false } };
    let r: any;
    expect(() => { r = evaluateExpr(ast, {}); }).not.toThrow();
    expect(r).toEqual({ ok: false, error: 'budget_exceeded' });
  });
  it('a deep right-leaning AST under budget does not overflow either', () => {
    let ast: any = { kind: 'lit', value: true };
    for (let i = 0; i < 4_000; i++) ast = { kind: 'not', arg: { kind: 'not', arg: ast } };
    expect(evaluateExpr(ast, {})).toEqual({ ok: true, value: true });
  });
  it('malformed hand-built AST never throws', () => {
    expect(() => evaluateExpr({ kind: 'nope' } as never, {})).not.toThrow();
    expect(evaluateExpr({ kind: 'nope' } as never, {}).ok).toBe(false);
  });
});

describe('isTruthy', () => {
  it('only true is true', () => {
    expect(isTruthy(true)).toBe(true);
    for (const v of [false, null, 1, 'true', '', [], {}] as never[]) expect(isTruthy(v)).toBe(false);
  });
});
