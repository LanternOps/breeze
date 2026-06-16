import { stripSheet } from '@breeze/office-addin-core';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

/**
 * MUTATING. D5: Office.js assigns the SAME formula text to every cell of the
 * target range (no relative-reference rewriting on assignment) — single-cell
 * targets behave exactly as expected; per-row formulas need one call per cell.
 */
export async function insertFormula(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const formula = requireString(input, 'formula');
  const sheetName = optionalString(input, 'sheetName');
  if (!formula.startsWith('=')) throw new ToolInputError('formula must start with "="');
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Formula fill of ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.formulas = Array.from({ length: rows }, () => Array.from({ length: cols }, () => formula));
    range.load('address');
    await context.sync();
    return { address: range.address, formula, cellCount: rows * cols };
  });
}
