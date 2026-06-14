import { stripSheet } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet } from './helpers';

/** MUTATING. */
export async function createTable(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const hasHeaders = input.hasHeaders === undefined ? true : input.hasHeaders === true;
  return Excel.run(async (context) => {
    const sheet = await resolveSheet(context, sheetName, address);
    sheet.load('name');
    await context.sync();
    const qualified = `${sheet.name}!${stripSheet(address)}`;
    const table = context.workbook.tables.add(qualified, hasHeaders);
    table.load('name');
    await context.sync();
    return { name: table.name, address: qualified, hasHeaders };
  });
}
