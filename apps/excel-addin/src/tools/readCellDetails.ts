import { columnLetter, parseAddress, stripSheet } from '@breeze/office-addin-core';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet } from './helpers';

/** Excel error sentinels (#REF!, #VALUE!, …) so we can flag a cell as an error
 *  even when valueTypes isn't reported (older Office.js builds). */
const EXCEL_ERROR_RE = /^#(REF|VALUE|DIV\/0|NAME\?|NULL|NUM|N\/A|SPILL|CALC)/;

function isErrorCell(valueType: unknown, value: unknown): boolean {
  if (valueType === 'Error') return true;
  return typeof value === 'string' && EXCEL_ERROR_RE.test(value);
}

/**
 * read_cell_details (read-only): return the value, formula, number format, and
 * any Excel error for a cell/range so the model can explain it. The values
 * matrix uses the wire-contract key `cells` (NOT `values`) so the server DLP
 * chokepoint scans it cell-by-cell.
 */
export async function readCellDetails(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Range ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.load(['address', 'values', 'formulas', 'numberFormat', 'valueTypes']);
    await context.sync();

    const values = range.values;
    const formulas = range.formulas;
    const numberFormats = range.numberFormat;
    const valueTypes = range.valueTypes;

    // Anchor for per-cell error addresses: the range's own sheet-qualified
    // top-left cell (e.g. "Budget!B2" → sheet "Budget", row 1, col 1).
    const parsed = parseAddress(range.address);
    const sheetPrefix = parsed.sheet ? `${parsed.sheet}!` : '';

    const errors: Array<{ address: string; value: unknown }> = [];
    for (let r = 0; r < values.length; r++) {
      const row = values[r] ?? [];
      for (let c = 0; c < row.length; c++) {
        const value = row[c];
        const valueType = valueTypes[r]?.[c];
        if (isErrorCell(valueType, value)) {
          const cellRef = `${columnLetter(parsed.startCol + c)}${parsed.startRow + r + 1}`;
          errors.push({ address: `${sheetPrefix}${cellRef}`, value });
        }
      }
    }

    return {
      address: range.address,
      cells: values,
      formulas,
      numberFormats,
      errors,
    };
  });
}
