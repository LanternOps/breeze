import { parseAddress, rangeAddress, stripSheet, type CellValue } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet, SEARCH_RESULT_CAP } from './helpers';

/** Case-insensitive substring scan over used ranges, capped at SEARCH_RESULT_CAP hits. */
export async function searchWorkbook(input: Record<string, unknown>): Promise<unknown> {
  const query = requireString(input, 'query');
  const sheetName = optionalString(input, 'sheetName');
  const needle = query.toLowerCase();
  return Excel.run(async (context) => {
    let sheets: Excel.Worksheet[];
    if (sheetName) {
      sheets = [await resolveSheet(context, sheetName)];
    } else {
      const collection = context.workbook.worksheets;
      collection.load('items/name');
      await context.sync();
      sheets = collection.items;
    }
    const scans = sheets.map((sheet) => {
      sheet.load('name');
      const used = sheet.getUsedRangeOrNullObject();
      used.load(['address', 'values']);
      return { sheet, used };
    });
    await context.sync();
    const results: Array<{ sheet: string; address: string; value: CellValue }> = [];
    let truncated = false;
    outer: for (const { sheet, used } of scans) {
      if (used.isNullObject) continue;
      const origin = parseAddress(stripSheet(used.address));
      const values = used.values as CellValue[][];
      for (let r = 0; r < values.length; r++) {
        const row = values[r]!;
        for (let c = 0; c < row.length; c++) {
          const value = row[c]!;
          if (value === null || value === '') continue;
          if (String(value).toLowerCase().includes(needle)) {
            if (results.length >= SEARCH_RESULT_CAP) {
              truncated = true;
              break outer;
            }
            results.push({
              sheet: sheet.name,
              address: rangeAddress(origin.startRow + r, origin.startCol + c, 1, 1),
              value,
            });
          }
        }
      }
    }
    // Also expose the matched cell text under the wire-contract key `cells`
    // (one match per row) so the server DLP chokepoint scans the found values
    // cell-by-cell (pass 1); the structured `results` field is retained.
    const cells: string[][] = results.map((r) => [String(r.value)]);
    return { query, results, cells, truncated };
  });
}
