/**
 * Context chip payload (spec §11): the user controls data egress per message.
 *   selection → address + values of the current selection
 *   sheet     → used range of the active sheet
 *   none      → { kind: 'none' } (explicit choice, recorded server-side)
 * Over CONTEXT_CELL_CAP cells, `cells` is omitted (address/sheetName only) —
 * the model can still pull narrower data through read tools.
 */
import { parseAddress } from '../lib/address';
import type { CellValue, WorkbookContext, WorkbookContextKind } from '../api/types';

export const CONTEXT_CELL_CAP = 10_000;

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
