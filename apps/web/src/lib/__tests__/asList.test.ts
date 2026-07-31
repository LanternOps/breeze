import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { asList } from '../asList';

// The fail-closed branch warns (deliberately — see the finding it fixes);
// silence it for the shape-drift cases below and assert it separately.
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe('asList', () => {
  it('unwraps the { data, pagination } envelope', () => {
    expect(asList({ data: [1, 2], pagination: { page: 1 } })).toEqual([1, 2]);
  });

  it('unwraps the { data, total } envelope', () => {
    expect(asList({ data: [{ id: 'g1' }], total: 1 })).toEqual([{ id: 'g1' }]);
  });

  it('unwraps a legacy plural key when data is absent', () => {
    expect(asList({ sites: [{ id: 's1' }] }, 'sites')).toEqual([{ id: 's1' }]);
  });

  it('accepts several alias keys', () => {
    expect(asList({ items: [1] }, 'patches', 'items')).toEqual([1]);
  });

  it('passes a bare array through', () => {
    expect(asList([1, 2, 3])).toEqual([1, 2, 3]);
  });

  // The whole point of the helper: these are the shapes that used to fall
  // through to the envelope object and crash the island on the next render.
  it.each([
    ['an unrecognised object', { unexpected: true }],
    ['a JSON error body returned with HTTP 200', { error: 'Forbidden' }],
    ['an envelope whose data is not an array', { data: { id: 'x' } }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'nope'],
    ['a number', 42],
  ])('returns [] for %s', (_label, payload) => {
    expect(asList(payload, 'sites')).toEqual([]);
  });

  it('never returns a non-array, so callers can always .map()', () => {
    const payloads = [{ unexpected: true }, null, undefined, 'x', 7, { data: 'not-an-array' }];
    for (const payload of payloads) {
      expect(() => asList(payload).map((x) => x)).not.toThrow();
    }
  });

  it('prefers data over an alias when both are present', () => {
    expect(asList({ data: ['envelope'], sites: ['legacy'] }, 'sites')).toEqual(['envelope']);
  });

  // The warn is the forensic trail for shape drift — pin that it fires on the
  // fail-closed object branch and stays quiet on recognized shapes.
  it('warns when an object payload carries no recognizable list', () => {
    asList({ error: 'Forbidden' }, 'sites');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('[asList]');
  });

  it('does not warn on recognized shapes or empty inputs', () => {
    asList({ data: [1] });
    asList({ sites: [] }, 'sites');
    asList([1, 2]);
    asList(null);
    asList(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
