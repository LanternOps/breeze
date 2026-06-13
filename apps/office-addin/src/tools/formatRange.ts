import { stripSheet } from '../lib/address';
import { addressDims, assertCellCap, optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

type FormatInput = {
  bold?: boolean;
  italic?: boolean;
  fontColor?: string;
  fillColor?: string;
  numberFormat?: string;
};

/** MUTATING. Applies a whitelisted subset of formatting to a range. */
export async function formatRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const raw = input.format;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('format must be an object');
  const format = raw as FormatInput;
  const { rows, cols } = addressDims(address);
  assertCellCap(rows, cols, `Format of ${address}`);
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    const applied: string[] = [];
    if (typeof format.bold === 'boolean') {
      range.format.font.bold = format.bold;
      applied.push('bold');
    }
    if (typeof format.italic === 'boolean') {
      range.format.font.italic = format.italic;
      applied.push('italic');
    }
    if (typeof format.fontColor === 'string') {
      range.format.font.color = format.fontColor;
      applied.push('fontColor');
    }
    if (typeof format.fillColor === 'string') {
      range.format.fill.color = format.fillColor;
      applied.push('fillColor');
    }
    if (typeof format.numberFormat === 'string') {
      range.numberFormat = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => format.numberFormat!),
      );
      applied.push('numberFormat');
    }
    if (applied.length === 0)
      throw new ToolInputError(
        'format contained no supported keys (bold, italic, fontColor, fillColor, numberFormat)',
      );
    range.load('address');
    await context.sync();
    return { address: range.address, applied };
  });
}
