/**
 * Write-preview builder (spec §5): reads the CURRENT target values so the
 * Apply/Reject card can show a real before/after diff. ≤200 cells renders the
 * full grid; above that a summary line (reading thousands of cells to draw an
 * unreadable table helps nobody).
 */
import { parseAddress, rangeAddress, stripSheet, type CellValue, type WritePreview } from '@breeze/office-addin-core';
import { addressDims, optionalString, requireCellMatrix, requireString, resolveSheet } from '../tools/helpers';

export type { WritePreview };

export const PREVIEW_GRID_CELL_CAP = 200;

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
      const after = requireCellMatrix(input, 'cells');
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
    case 'create_pivot_table': {
      const sourceAddress = requireString(input, 'sourceAddress');
      const destinationAddress = requireString(input, 'destinationAddress');
      const rows = Array.isArray(input.rows) ? (input.rows as unknown[]).map(String) : [];
      const columns = Array.isArray(input.columns) ? (input.columns as unknown[]).map(String) : [];
      const values = Array.isArray(input.values)
        ? (input.values as Array<{ field?: unknown; aggregation?: unknown }>).map((v) => {
            const field = typeof v?.field === 'string' ? v.field : '?';
            const agg = typeof v?.aggregation === 'string' ? v.aggregation : 'sum';
            return `${agg}(${field})`;
          })
        : [];
      const parts = [
        `rows=${rows.join(', ') || '—'}`,
        ...(columns.length ? [`columns=${columns.join(', ')}`] : []),
        `values=${values.join(', ') || '—'}`,
      ];
      return {
        kind: 'summary',
        toolName,
        target: destinationAddress,
        description: `PivotTable from ${sourceAddress} → ${parts.join('; ')}`,
      };
    }
    case 'create_chart': {
      const sourceAddress = requireString(input, 'sourceAddress');
      const chartType = requireString(input, 'chartType');
      const title = optionalString(input, 'title');
      return {
        kind: 'summary',
        toolName,
        target: sourceAddress,
        description: `Create a ${chartType} chart from ${sourceAddress}${title ? ` titled "${title}"` : ''}`,
      };
    }
    case 'clear_range': {
      const address = requireString(input, 'address');
      const what =
        input.what === 'formats' || input.what === 'all' ? (input.what as string) : 'contents';
      return { kind: 'summary', toolName, target: address, description: `Clear ${what} of ${address}` };
    }
    case 'sort_range': {
      const address = requireString(input, 'address');
      const cols = Array.isArray(input.columns) ? input.columns.length : 0;
      const plural = cols === 1 ? 'column' : 'columns';
      return {
        kind: 'summary',
        toolName,
        target: address,
        description: `Sort ${address} by ${cols} ${plural}`,
      };
    }
    default:
      return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
  }
}
