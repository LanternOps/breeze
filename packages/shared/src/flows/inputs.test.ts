import { describe, it, expect } from 'vitest';
import { coerceFlowInputs } from './inputs';
import type { FlowDocumentV1 } from '../validators/flows';

const decl = (
  name: string,
  type: 'string' | 'number' | 'boolean' | 'uuid',
  required = false,
): FlowDocumentV1['inputs'][number] => ({ name, type, required });

describe('coerceFlowInputs', () => {
  it('coerces numeric strings and numbers', () => {
    expect(coerceFlowInputs([decl('count', 'number')], { count: '3' })).toEqual({ ok: true, inputs: { count: 3 } });
    expect(coerceFlowInputs([decl('count', 'number')], { count: 4.5 })).toEqual({ ok: true, inputs: { count: 4.5 } });
  });

  it.each(['x', '', 'Infinity', '  '])('rejects number %j', (v) => {
    expect(coerceFlowInputs([decl('count', 'number')], { count: v }).ok).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    expect(coerceFlowInputs([decl('count', 'number')], { count: Infinity }).ok).toBe(false);
    expect(coerceFlowInputs([decl('count', 'number')], { count: NaN }).ok).toBe(false);
  });

  it('accepts booleans and true/false strings only', () => {
    expect(coerceFlowInputs([decl('b', 'boolean')], { b: 'true' })).toEqual({ ok: true, inputs: { b: true } });
    expect(coerceFlowInputs([decl('b', 'boolean')], { b: false })).toEqual({ ok: true, inputs: { b: false } });
    expect(coerceFlowInputs([decl('b', 'boolean')], { b: 'yes' }).ok).toBe(false);
  });

  it('enforces the 4096 char string limit', () => {
    expect(coerceFlowInputs([decl('s', 'string')], { s: 'a'.repeat(4096) }).ok).toBe(true);
    expect(coerceFlowInputs([decl('s', 'string')], { s: 'a'.repeat(4097) }).ok).toBe(false);
    expect(coerceFlowInputs([decl('s', 'string')], { s: 5 }).ok).toBe(false);
  });

  it('flags undeclared keys', () => {
    const r = coerceFlowInputs([decl('a', 'string')], { a: 'x', extra: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.name)).toContain('extra');
  });

  it('flags missing required inputs, including null', () => {
    expect(coerceFlowInputs([decl('a', 'string', true)], {}).ok).toBe(false);
    expect(coerceFlowInputs([decl('a', 'string', true)], { a: null }).ok).toBe(false);
  });

  it('absent or null optional becomes null', () => {
    expect(coerceFlowInputs([decl('a', 'string')], {})).toEqual({ ok: true, inputs: { a: null } });
    expect(coerceFlowInputs([decl('a', 'number')], { a: null })).toEqual({ ok: true, inputs: { a: null } });
  });

  it('lowercases a valid uuid and rejects an invalid one', () => {
    const u = '8B2C1F4E-1111-4222-8333-ABCDEF012345';
    expect(coerceFlowInputs([decl('id', 'uuid')], { id: u })).toEqual({ ok: true, inputs: { id: u.toLowerCase() } });
    expect(coerceFlowInputs([decl('id', 'uuid')], { id: 'nope' }).ok).toBe(false);
  });

  it('collects every issue', () => {
    const r = coerceFlowInputs([decl('a', 'number'), decl('b', 'uuid')], { a: 'x', b: 'y', c: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toHaveLength(3);
  });
});
