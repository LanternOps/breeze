/**
 * Write-preview builder (spec §5): reads the CURRENT target values so the
 * Apply/Reject card can show a real before/after diff. ≤200 cells renders the
 * full grid; above that a summary line (reading thousands of cells to draw an
 * unreadable table helps nobody).
 */
import { parseAddress, rangeAddress, stripSheet } from '../lib/address';
import { addressDims, optionalString, requireCellMatrix, requireString, resolveSheet } from '../tools/helpers';
import type { CellValue } from '../api/types';

export const PREVIEW_GRID_CELL_CAP = 200;

export type WritePreview =
  | {
      kind: 'grid';
      toolName: string;
      target: string;
      before: CellValue[][];
      after: CellValue[][];
      changedCount: number;
    }
  | { kind: 'summary'; toolName: string; target: string; description: string };

async function readCurrent(
  sheetName: string | undefined,
  address: string,
  rows: number,
  cols: number,
): Promise<{ qualified: string; values: CellValue[][] }> {
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const parsed = parseAddress(stripSheet(address));
    const range = sheet.getRange(rangeAddress(parsed.startRow, parsed.startCol, rows, cols));
    range.load(['address', 'values']);
    await context.sync();
    return { qualified: range.address, values: range.values as CellValue[][] };
  });
}

function diffCount(before: CellValue[][], after: CellValue[][]): number {
  let changed = 0;
  for (let r = 0; r < after.length; r++) {
    for (let c = 0; c < after[r]!.length; c++) {
      if ((before[r]?.[c] ?? '') !== after[r]![c]) changed++;
    }
  }
  return changed;
}

export async function buildWritePreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WritePreview> {
  switch (toolName) {
    case 'write_range': {
      const address = requireString(input, 'address');
      const sheetName = optionalString(input, 'sheetName');
      const after = requireCellMatrix(input, 'values');
      const rows = after.length;
      const cols = after[0]!.length;
      if (rows * cols > PREVIEW_GRID_CELL_CAP)
        return {
          kind: 'summary',
          toolName,
          target: address,
          description: `Write ${rows}×${cols} cells (${rows * cols} cells) starting at ${address}`,
        };
      const { qualified, values: before } = await readCurrent(sheetName, address, rows, cols);
      return { kind: 'grid', toolName, target: qualified, before, after, changedCount: diffCount(before, after) };
    }
    case 'insert_formula': {
      const address = requireString(input, 'address');
      const sheetName = optionalString(input, 'sheetName');
      const formula = requireString(input, 'formula');
      const { rows, cols } = addressDims(address);
      if (rows * cols > PREVIEW_GRID_CELL_CAP)
        return {
          kind: 'summary',
          toolName,
          target: address,
          description: `Fill ${address} (${rows * cols} cells) with the formula ${formula}`,
        };
      const after: CellValue[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => formula),
      );
      const { qualified, values: before } = await readCurrent(sheetName, address, rows, cols);
      return { kind: 'grid', toolName, target: qualified, before, after, changedCount: diffCount(before, after) };
    }
    case 'create_sheet': {
      const name = requireString(input, 'name');
      return { kind: 'summary', toolName, target: name, description: `Create a new sheet named "${name}"` };
    }
    case 'format_range': {
      const address = requireString(input, 'address');
      const format = input.format;
      const keys =
        format && typeof format === 'object' && !Array.isArray(format)
          ? Object.keys(format as object).join(', ')
          : '';
      return {
        kind: 'summary',
        toolName,
        target: address,
        description: `Apply formatting (${keys || 'none'}) to ${address}`,
      };
    }
    case 'create_table': {
      const address = requireString(input, 'address');
      return { kind: 'summary', toolName, target: address, description: `Create a table over ${address}` };
    }
    default:
      return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
  }
}
