import { parseAddress, rangeAddress, stripSheet } from '@breeze/office-addin-core';
import {
  addressDims,
  assertCellCap,
  optionalString,
  requireCellMatrix,
  requireString,
  resolveSheet,
  ToolInputError,
} from './helpers';

/**
 * MUTATING — only ever invoked through the approval store (Task 8).
 * A single-cell address acts as an anchor: the full matrix writes from there.
 * A multi-cell address must match the matrix dimensions exactly.
 */
export async function writeRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const values = requireCellMatrix(input, 'cells');
  const { rows, cols } = addressDims(address);
  const isAnchor = rows === 1 && cols === 1;
  if (!isAnchor && (rows !== values.length || cols !== values[0]!.length))
    throw new ToolInputError(
      `cells is ${values.length}x${values[0]!.length} but ${stripSheet(address)} is ${rows}x${cols}`,
    );
  assertCellCap(values.length, values[0]!.length, `Write to ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const parsed = parseAddress(stripSheet(address));
    const target = rangeAddress(parsed.startRow, parsed.startCol, values.length, values[0]!.length);
    const range = sheet.getRange(target);
    range.values = values;
    range.load('address');
    await context.sync();
    return { address: range.address, rowsWritten: values.length, columnsWritten: values[0]!.length };
  });
}
