import { stripSheet } from '@breeze/office-addin-core';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet } from './helpers';

export async function readRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Range ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.load(['address', 'values', 'rowCount', 'columnCount']);
    await context.sync();
    return {
      address: range.address,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      // Wire-contract key `cells` (NOT `values`) so the server DLP chokepoint
      // scans the matrix cell-by-cell (pass 1).
      cells: range.values,
    };
  });
}
