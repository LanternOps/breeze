/**
 * Shared tool plumbing: input validation (model input is untrusted), sheet
 * resolution, and payload caps. Caps mirror the server side: 50k cells is the
 * DLP engine's fail-closed limit (Plan 3) — anything bigger would be refused
 * there anyway, so fail fast here with a message the model can act on.
 */
import {
  ToolInputError,
  parseAddress,
  requireString,
  optionalString,
  stripSheet,
  type CellValue,
} from '@breeze/office-addin-core';

// Host-neutral validators now live in the core; re-exported here so the Excel
// tool files (which import them from this module) need no edits.
export { ToolInputError, requireString, optionalString };

export const MAX_TOOL_CELLS = 50_000;
export const SEARCH_RESULT_CAP = 200;
export const OVERVIEW_HEADER_CAP = 50;

export function requireCellMatrix(input: Record<string, unknown>, key: string): CellValue[][] {
  const value = input[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((row) => Array.isArray(row)))
    throw new ToolInputError(`${key} must be a non-empty 2D array`);
  const matrix = value as unknown[][];
  const width = matrix[0]!.length;
  if (width === 0 || !matrix.every((row) => row.length === width))
    throw new ToolInputError(`${key} must be rectangular (every row the same length)`);
  for (const row of matrix) {
    for (const cell of row) {
      if (
        cell !== null &&
        typeof cell !== 'string' &&
        typeof cell !== 'number' &&
        typeof cell !== 'boolean'
      )
        throw new ToolInputError(`${key} cells must be string | number | boolean | null`);
    }
  }
  return matrix as CellValue[][];
}

export function assertCellCap(rows: number, cols: number, what: string): void {
  if (rows * cols > MAX_TOOL_CELLS)
    throw new ToolInputError(
      `${what} covers ${rows * cols} cells — over the ${MAX_TOOL_CELLS}-cell limit. Use a narrower range.`,
    );
}

export function addressDims(address: string): { rows: number; cols: number } {
  const p = parseAddress(stripSheet(address));
  return { rows: p.endRow - p.startRow + 1, cols: p.endCol - p.startCol + 1 };
}

/** Explicit sheetName > sheet embedded in the address > active sheet. */
export async function resolveSheet(
  context: Excel.RequestContext,
  sheetName: string | undefined,
  address?: string,
): Promise<Excel.Worksheet> {
  const fromAddress = address?.includes('!') ? parseAddress(address).sheet : null;
  const name = sheetName ?? fromAddress ?? null;
  if (!name) return context.workbook.worksheets.getActiveWorksheet();
  const sheet = context.workbook.worksheets.getItemOrNullObject(name);
  await context.sync();
  if (sheet.isNullObject) throw new ToolInputError(`No worksheet named "${name}"`);
  return sheet;
}
