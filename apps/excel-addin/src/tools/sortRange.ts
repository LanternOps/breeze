import { stripSheet } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

type SortColumn = { column: number; ascending?: boolean };

function requireSortColumns(input: Record<string, unknown>): SortColumn[] {
  const value = input.columns;
  if (!Array.isArray(value) || value.length === 0)
    throw new ToolInputError('columns must be a non-empty array of { column, ascending? }');
  return value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new ToolInputError('each columns entry must be an object { column, ascending? }');
    const entry = raw as Record<string, unknown>;
    if (typeof entry.column !== 'number' || !Number.isInteger(entry.column) || entry.column < 0)
      throw new ToolInputError('column must be a non-negative integer offset within the range');
    if (entry.ascending !== undefined && typeof entry.ascending !== 'boolean')
      throw new ToolInputError('ascending must be a boolean');
    return { column: entry.column, ascending: entry.ascending as boolean | undefined };
  });
}

/** MUTATING — only ever invoked through the approval store. Sorts the rows of a
 *  range by one or more 0-based column offsets within that range. */
export async function sortRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const columns = requireSortColumns(input);
  const hasHeaders = input.hasHeaders === true;
  const fields: Excel.SortField[] = columns.map((c) => ({
    key: c.column,
    ascending: c.ascending !== false,
  }));
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.sort.apply(fields, /* matchCase */ false, hasHeaders);
    range.load('address');
    await context.sync();
    return { address: range.address, sortedColumns: fields.length, hasHeaders };
  });
}
