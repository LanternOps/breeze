import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { buildWritePreview, PREVIEW_GRID_CELL_CAP } from './buildPreview';

describe('buildWritePreview', () => {
  it('builds a before/after grid with changedCount for small write_range inputs', async () => {
    getOfficeMock().setValues('Sheet1', 'B2', [
      ['old', 'same'],
    ]);
    const preview = await buildWritePreview('write_range', {
      address: 'B2',
      values: [['new', 'same']],
    });
    expect(preview).toEqual({
      kind: 'grid',
      toolName: 'write_range',
      target: 'Sheet1!B2:C2',
      before: [['old', 'same']],
      after: [['new', 'same']],
      changedCount: 1,
    });
  });

  it('falls back to a summary line above the grid cap', async () => {
    const rows = 30;
    const cols = 10; // 300 cells > 200
    expect(rows * cols).toBeGreaterThan(PREVIEW_GRID_CELL_CAP);
    const preview = await buildWritePreview('write_range', {
      address: 'A1',
      values: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'x')),
    });
    expect(preview.kind).toBe('summary');
    expect(preview.target).toBe('A1');
    expect((preview as { description: string }).description).toContain('300 cells');
  });

  it('previews insert_formula as a grid of the formula text', async () => {
    getOfficeMock().setValues('Sheet1', 'D1', [[5]]);
    const preview = await buildWritePreview('insert_formula', {
      address: 'D1',
      formula: '=SUM(A1:C1)',
    });
    expect(preview).toMatchObject({
      kind: 'grid',
      target: 'Sheet1!D1',
      before: [[5]],
      after: [['=SUM(A1:C1)']],
      changedCount: 1,
    });
  });

  it('summarizes create_sheet / format_range / create_table', async () => {
    const sheet = await buildWritePreview('create_sheet', { name: 'Report' });
    expect(sheet).toMatchObject({ kind: 'summary', target: 'Report' });
    const fmt = await buildWritePreview('format_range', {
      address: 'A1:B2',
      format: { bold: true },
    });
    expect(fmt).toMatchObject({ kind: 'summary', target: 'A1:B2' });
    expect((fmt as { description: string }).description).toContain('bold');
    const table = await buildWritePreview('create_table', { address: 'A1:C10' });
    expect(table).toMatchObject({ kind: 'summary', target: 'A1:C10' });
  });
});
