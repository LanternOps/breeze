import { describe, it, expect } from 'vitest';
import { applyDlp } from './clientAiDlp';

const ORG = '0a1b2c3d-1111-4222-8333-444455556666';

describe('applyDlp seam (Plan-2 stub — assertions stay valid against the Plan-3 engine)', () => {
  it('passes clean text through unchanged', async () => {
    const r = await applyDlp({ text: 'sum column B please', dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', text: 'sum column B please', redactions: [] });
  });

  it('passes clean cells through with equal values and does not mutate the input', async () => {
    const cells = [['Name', 'Qty'], ['Widget', 12]];
    const r = await applyDlp({ cells, dlpConfig: {}, orgId: ORG });
    expect(r.action).toBe('allow');
    expect(r.cells).toEqual(cells);
    expect(r.redactions).toEqual([]);
    expect(cells).toEqual([['Name', 'Qty'], ['Widget', 12]]); // never mutated
  });

  it('handles empty input (no text, no cells)', async () => {
    const r = await applyDlp({ dlpConfig: {}, orgId: ORG });
    expect(r).toEqual({ action: 'allow', redactions: [] });
  });

  it('scans text and cells in the same call', async () => {
    const r = await applyDlp({ text: 'hello', cells: [['x']], dlpConfig: {}, orgId: ORG });
    expect(r.text).toBe('hello');
    expect(r.cells).toEqual([['x']]);
  });
});
