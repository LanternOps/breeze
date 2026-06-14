import { requireString, ToolInputError } from './helpers';

/** MUTATING. */
export async function createSheet(input: Record<string, unknown>): Promise<unknown> {
  const name = requireString(input, 'name');
  if (name.length > 31 || /[\\/?*[\]:]/.test(name))
    throw new ToolInputError('Invalid sheet name (max 31 chars; no \\ / ? * [ ] :)');
  return Excel.run(async (context) => {
    const existing = context.workbook.worksheets.getItemOrNullObject(name);
    await context.sync();
    if (!existing.isNullObject) throw new ToolInputError(`A sheet named "${name}" already exists`);
    const sheet = context.workbook.worksheets.add(name);
    sheet.load('name');
    await context.sync();
    return { name: sheet.name, created: true };
  });
}
