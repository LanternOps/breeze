import { describe, expect, it } from 'vitest';
import { getOfficeMock } from '../__tests__/officeMock';
import { createPivotTable } from './createPivotTable';

describe('create_pivot_table', () => {
  it('creates a pivot table with row/column/data hierarchies and reports it', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['Region', 'Quarter', 'Revenue', 'Units', 'X', 'Y']]);
    const result = (await createPivotTable({
      sourceAddress: 'A1:F500',
      destinationAddress: 'H1',
      rows: ['Region'],
      columns: ['Quarter'],
      values: [
        { field: 'Revenue', aggregation: 'sum' },
        { field: 'Units', aggregation: 'average' },
      ],
    })) as {
      name: string;
      sourceAddress: string;
      destinationAddress: string;
      rows: string[];
      columns: string[];
      values: Array<{ field: string; aggregation: string }>;
    };
    expect(result.sourceAddress).toBe('Sheet1!A1:F500');
    expect(result.destinationAddress).toBe('Sheet1!H1');
    expect(result.rows).toEqual(['Region']);
    expect(result.columns).toEqual(['Quarter']);
    expect(result.values).toEqual([
      { field: 'Revenue', aggregation: 'sum' },
      { field: 'Units', aggregation: 'average' },
    ]);

    const pivots = getOfficeMock().pivotTables;
    expect(pivots).toHaveLength(1);
    expect(pivots[0]).toMatchObject({
      rowHierarchies: ['Region'],
      columnHierarchies: ['Quarter'],
      dataHierarchies: [
        { field: 'Revenue', summarizeBy: 'Sum' },
        { field: 'Units', summarizeBy: 'Average' },
      ],
    });
  });

  it('defaults aggregation to sum when omitted', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['Category', 'Amount', 'Z']]);
    await createPivotTable({
      sourceAddress: 'A1:C100',
      destinationAddress: 'E1',
      rows: ['Category'],
      values: [{ field: 'Amount' }],
    });
    expect(getOfficeMock().pivotTables[0]!.dataHierarchies).toEqual([
      { field: 'Amount', summarizeBy: 'Sum' },
    ]);
  });

  it('returns a clear error string when ExcelApi 1.8 is not supported (no pivot created)', async () => {
    getOfficeMock().supportedApiSets.delete('1.8');
    const result = (await createPivotTable({
      sourceAddress: 'A1:C100',
      destinationAddress: 'E1',
      rows: ['Category'],
      values: [{ field: 'Amount' }],
    })) as { error: string };
    expect(result.error).toMatch(/not support/i);
    expect(result.error).toMatch(/1\.8/);
    expect(getOfficeMock().pivotTables).toHaveLength(0);
  });

  it('errors when a requested field is not a header in the source', async () => {
    getOfficeMock().setValues('Sheet1', 'A1', [['Category', 'Amount', 'Z']]);
    await expect(
      createPivotTable({
        sourceAddress: 'A1:C100',
        destinationAddress: 'E1',
        rows: ['NoSuchField'],
        values: [{ field: 'Amount' }],
      }),
    ).rejects.toThrow(/NoSuchField/);
  });

  it('rejects an unknown aggregation', async () => {
    await expect(
      createPivotTable({
        sourceAddress: 'A1:C100',
        destinationAddress: 'E1',
        rows: ['Category'],
        values: [{ field: 'Amount', aggregation: 'median' }],
      }),
    ).rejects.toThrow(/aggregation/);
  });
});
