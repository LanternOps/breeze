import { OVERVIEW_HEADER_CAP } from './helpers';
import type { CellValue } from '@breeze/office-addin-core';

/** Sheet names + used ranges + first-row headers — the model's map of the workbook. */
export async function getWorkbookOverview(_input: Record<string, unknown>): Promise<unknown> {
  return Excel.run(async (context) => {
    const collection = context.workbook.worksheets;
    collection.load('items/name');
    await context.sync();
    const scans = collection.items.map((sheet) => {
      const used = sheet.getUsedRangeOrNullObject();
      used.load('address');
      const headerRow = used.getRow(0); // header row only — never hydrate the whole used range
      headerRow.load('values');
      return { sheet, used, headerRow };
    });
    await context.sync();
    const sheets = scans.map(({ sheet, used, headerRow }) => {
      if (used.isNullObject) return { name: sheet.name, usedRange: null, headers: [] as CellValue[] };
      const headers = ((headerRow.values[0] ?? []) as CellValue[]).slice(0, OVERVIEW_HEADER_CAP);
      return { name: sheet.name, usedRange: used.address, headers };
    });
    return { sheets };
  });
}
