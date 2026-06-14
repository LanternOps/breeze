/**
 * Context chip payload (spec §11): the user controls data egress per message.
 *   selection → address + values of the current selection
 *   sheet     → used range of the active sheet
 *   none      → { kind: 'none' } (explicit choice, recorded server-side)
 * Over CONTEXT_CELL_CAP cells, `cells` is omitted (address/sheetName only) —
 * the model can still pull narrower data through read tools.
 */
import { parseAddress, type CellValue, type WorkbookContext, type WorkbookContextKind } from '@breeze/office-addin-core';

export const CONTEXT_CELL_CAP = 10_000;

/**
 * The open workbook's file name (e.g. "Q3 Budget.xlsx"), captured at session
 * create so the per-user history list can tag/filter by file. Returns undefined
 * when Office.js is unavailable or the name can't be read — capture must never
 * block session creation.
 */
export async function captureWorkbookName(): Promise<string | undefined> {
  try {
    return await Excel.run(async (context) => {
      const wb = context.workbook;
      wb.load('name');
      await context.sync();
      const name = wb.name?.trim();
      return name ? name : undefined;
    });
  } catch {
    return undefined;
  }
}

export async function captureWorkbookContext(
  kind: WorkbookContextKind,
): Promise<WorkbookContext | undefined> {
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'selection') {
    return Excel.run(async (context) => {
      const range = context.workbook.getSelectedRange();
      range.load(['address', 'values', 'rowCount', 'columnCount']);
      await context.sync();
      const sheetName = parseAddress(range.address).sheet ?? undefined;
      const payload: WorkbookContext = {
        kind: 'selection',
        address: range.address,
        ...(sheetName ? { sheetName } : {}),
      };
      if (range.rowCount * range.columnCount <= CONTEXT_CELL_CAP)
        payload.cells = range.values as CellValue[][];
      return payload;
    });
  }
  return Excel.run(async (context) => {
    const sheet = context.workbook.worksheets.getActiveWorksheet();
    sheet.load('name');
    const used = sheet.getUsedRangeOrNullObject();
    used.load(['address', 'values', 'rowCount', 'columnCount']);
    await context.sync();
    if (used.isNullObject) return { kind: 'sheet', sheetName: sheet.name };
    const payload: WorkbookContext = { kind: 'sheet', sheetName: sheet.name, address: used.address };
    if (used.rowCount * used.columnCount <= CONTEXT_CELL_CAP)
      payload.cells = used.values as CellValue[][];
    return payload;
  });
}
