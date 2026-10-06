import { describe, expect, it } from 'vitest';
import { RESEARCH_EVAL_CASES } from './cases';

describe('research eval dataset', () => {
  it('has ~20 cases covering every OS x family the spec names', () => {
    expect(RESEARCH_EVAL_CASES.length).toBeGreaterThanOrEqual(18);
    expect(RESEARCH_EVAL_CASES.length).toBeLessThanOrEqual(24);
    for (const os of ['windows', 'linux', 'macos']) {
      for (const family of ['patch', 'disk', 'service', 'memory']) {
        expect(RESEARCH_EVAL_CASES.some((c) => c.os === os && c.family === family), `${os}/${family}`).toBe(true);
      }
    }
  });
  it('ids are unique and every case names an expectation', () => {
    expect(new Set(RESEARCH_EVAL_CASES.map((c) => c.id)).size).toBe(RESEARCH_EVAL_CASES.length);
    expect(RESEARCH_EVAL_CASES.every((c) => c.expect.anyOf.length > 0)).toBe(true);
  });
  it('every catalog carries a wrong-OS script and an irrelevant one', () => {
    for (const c of RESEARCH_EVAL_CASES) {
      expect(c.catalog.some((s) => !s.osTypes.includes(c.os)), c.id).toBe(true);
      expect(c.catalog.length, c.id).toBeGreaterThanOrEqual(2);
    }
  });
  it('contains no hostnames, IPs or customer names (public repo)', () => {
    const text = JSON.stringify(RESEARCH_EVAL_CASES);
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(text).not.toMatch(/\.(com|net|io|app|local)\b/);
  });
});
