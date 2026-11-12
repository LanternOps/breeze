import { describe, expect, it } from 'vitest';
import { formatImportHash, parseImportHash } from './ticketImportHash';

const ID = '6f1c2b0a-5d4e-4f3a-8b2c-1d0e9f8a7b6c';

describe('ticket import hash (#8313 W6)', () => {
  it('reads source and step, in any order, with or without the #', () => {
    expect(parseImportHash(`source=${ID}&step=mappings`)).toEqual({ sourceId: ID, step: 'mappings' });
    expect(parseImportHash(`#step=dry-run&source=${ID}`)).toEqual({ sourceId: ID, step: 'dry-run' });
    expect(parseImportHash('step=connect')).toEqual({ sourceId: null, step: 'connect' });
    expect(parseImportHash('')).toEqual({ sourceId: null, step: null });
  });

  it('drops a source that is not a uuid and an unknown step', () => {
    expect(parseImportHash('source=../../etc&step=nope')).toEqual({ sourceId: null, step: null });
    expect(parseImportHash(`source=${ID.toUpperCase()}`)).toEqual({ sourceId: ID, step: null });
  });

  it('writes source before step and omits what is unset', () => {
    expect(formatImportHash({ sourceId: ID, step: 'window' })).toBe(`#source=${ID}&step=window`);
    expect(formatImportHash({ sourceId: null, step: 'connect' })).toBe('#step=connect');
    expect(formatImportHash({ sourceId: null, step: null })).toBe('');
  });

  it('round-trips every step', () => {
    for (const step of ['connect', 'preflight', 'mappings', 'dry-run', 'window', 'bulk', 'delta', 'close'] as const) {
      expect(parseImportHash(formatImportHash({ sourceId: ID, step }))).toEqual({ sourceId: ID, step });
    }
  });
});
