import { assertCellCap } from './helpers';

/** Reads the user's current selection. Two-phase: dims first, values only when under the cap. */
export async function readSelection(_input: Record<string, unknown>): Promise<unknown> {
  return Excel.run(async (context) => {
    const range = context.workbook.getSelectedRange();
    range.load(['address', 'rowCount', 'columnCount']);
    await context.sync();
    assertCellCap(range.rowCount, range.columnCount, `Selection ${range.address}`);
    range.load('values');
    await context.sync();
    return {
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      values: range.values,
    };
  });
}
