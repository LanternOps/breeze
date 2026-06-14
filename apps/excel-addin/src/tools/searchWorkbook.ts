import { parseAddress, rangeAddress, stripSheet } from '../lib/address';
import { optionalString, requireString, resolveSheet, SEARCH_RESULT_CAP } from './helpers';
import type { CellValue } from '../api/types';

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
    return { query, results, truncated };
  });
}
