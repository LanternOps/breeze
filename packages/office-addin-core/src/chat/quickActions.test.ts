import { describe, it, expect } from 'vitest';
import { summarizeSelection, quickActionsFor, type QuickAction } from './quickActions';
import type { WorkbookContext } from '../api/types';

function ids(actions: QuickAction[]): string[] {
  return actions.map((a) => a.id);
}

describe('summarizeSelection', () => {
  it('reports empty when there is no context', () => {
    expect(summarizeSelection(undefined)).toEqual({ shape: 'empty' });
  });

  it('reports empty for an explicit none context', () => {
    expect(summarizeSelection({ kind: 'none' })).toEqual({ shape: 'empty' });
  });

  it('reports empty for a selection with no cells (over the cell cap)', () => {
    // captureContext omits `cells` when the range is too large; treat as unknown/empty.
    expect(summarizeSelection({ kind: 'selection', address: 'A1:Z9999' })).toEqual({
      shape: 'empty',
    });
  });

  it('detects a single cell containing a formula', () => {
    const ctx: WorkbookContext = { kind: 'selection', address: 'B2', cells: [['=SUM(A1:A10)']] };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'formula', address: 'B2' });
  });

  it('treats a single non-formula cell as a generic single value (not formula)', () => {
    const ctx: WorkbookContext = { kind: 'selection', address: 'B2', cells: [['hello']] };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'single', address: 'B2' });
  });

  it('detects a multi-cell mostly-numeric range', () => {
    const ctx: WorkbookContext = {
      kind: 'selection',
      address: 'A1:B3',
      cells: [
        [1, 2],
        [3, 4],
        [5, 6],
      ],
    };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'numeric', address: 'A1:B3' });
  });

  it('detects a table-like range (header row of text over numeric/text body)', () => {
    const ctx: WorkbookContext = {
      kind: 'selection',
      address: 'A1:C4',
      cells: [
        ['Name', 'Region', 'Amount'],
        ['Acme', 'EU', 100],
        ['Beta', 'US', 200],
        ['Acme', 'EU', 100],
      ],
    };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'table', address: 'A1:C4' });
  });

  it('falls back to range for a multi-cell selection that is neither numeric nor table-like', () => {
    const ctx: WorkbookContext = {
      kind: 'selection',
      address: 'A1:A3',
      cells: [['a'], ['b'], ['c']],
    };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'range', address: 'A1:A3' });
  });

  it('treats a sheet-kind context as a sheet summary', () => {
    const ctx: WorkbookContext = {
      kind: 'sheet',
      sheetName: 'Sheet1',
      address: 'A1:C4',
      cells: [
        ['Name', 'Region', 'Amount'],
        ['Acme', 'EU', 100],
        ['Beta', 'US', 200],
        ['Acme', 'EU', 100],
      ],
    };
    expect(summarizeSelection(ctx)).toEqual({ shape: 'sheet', address: 'A1:C4' });
  });
});

describe('quickActionsFor', () => {
  it('empty selection → generic sheet-level suggestions', () => {
    const actions = quickActionsFor({ shape: 'empty' });
    expect(ids(actions)).toEqual(['summarize-sheet', 'what-can-you-do']);
    // every chip carries a non-empty, natural-language canned prompt
    for (const a of actions) expect(a.prompt.length).toBeGreaterThan(0);
  });

  it('formula cell → explain-formula chip referencing the selected cell', () => {
    const actions = quickActionsFor({ shape: 'formula', address: 'B2' });
    expect(ids(actions)).toContain('explain-formula');
    const explain = actions.find((a) => a.id === 'explain-formula')!;
    expect(explain.prompt.toLowerCase()).toContain('formula');
    expect(explain.prompt.toLowerCase()).toContain('selected');
  });

  it('numeric range → summarize + chart chips', () => {
    const actions = quickActionsFor({ shape: 'numeric', address: 'A1:B3' });
    const idList = ids(actions);
    expect(idList).toContain('summarize-data');
    expect(idList).toContain('make-chart');
  });

  it('table-like range → find-duplicates + clean-data chips', () => {
    const actions = quickActionsFor({ shape: 'table', address: 'A1:C4' });
    const idList = ids(actions);
    expect(idList).toContain('find-duplicates');
    expect(idList).toContain('clean-data');
  });

  it('single non-formula cell → a small sensible default set', () => {
    const actions = quickActionsFor({ shape: 'single', address: 'B2' });
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.length).toBeLessThanOrEqual(4);
  });

  it('sheet shape → summarize-sheet style suggestions', () => {
    const actions = quickActionsFor({ shape: 'sheet', address: 'A1:C4' });
    expect(ids(actions)).toContain('summarize-sheet');
  });

  it('never returns more than four chips for any shape', () => {
    const shapes = ['empty', 'single', 'formula', 'numeric', 'table', 'range', 'sheet'] as const;
    for (const shape of shapes) {
      const actions = quickActionsFor({ shape, address: 'A1' } as never);
      expect(actions.length).toBeLessThanOrEqual(4);
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it('chip prompts are deterministic and reference the selection naturally', () => {
    const actions = quickActionsFor({ shape: 'numeric', address: 'A1:B3' });
    const summarize = actions.find((a) => a.id === 'summarize-data')!;
    expect(summarize.prompt.toLowerCase()).toContain('selected');
  });
});
