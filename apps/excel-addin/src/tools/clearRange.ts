import { stripSheet } from '@breeze/office-addin-core';
import { optionalString, requireString, resolveSheet, ToolInputError } from './helpers';

type ClearWhat = 'contents' | 'formats' | 'all';

/** MUTATING — only ever invoked through the approval store. Clears a range's
 *  contents (values/formulas), its formats, or both. */
export async function clearRange(input: Record<string, unknown>): Promise<unknown> {
  const address = requireString(input, 'address');
  const sheetName = optionalString(input, 'sheetName');
  const rawWhat = input.what === undefined || input.what === null ? 'contents' : input.what;
  if (rawWhat !== 'contents' && rawWhat !== 'formats' && rawWhat !== 'all')
    throw new ToolInputError('what must be one of "contents", "formats", or "all"');
  const what = rawWhat as ClearWhat;
  return Excel.run(async (context) => {
    // Enum is resolved lazily inside Excel.run so the Office.js host is present.
    const applyTo: Record<ClearWhat, Excel.ClearApplyTo> = {
      contents: Excel.ClearApplyTo.contents,
      formats: Excel.ClearApplyTo.formats,
      all: Excel.ClearApplyTo.all,
    };
    const sheet = await resolveSheet(context, sheetName, address);
    const range = sheet.getRange(stripSheet(address));
    range.clear(applyTo[what]);
    range.load('address');
    await context.sync();
    return { address: range.address, cleared: what };
  });
}
