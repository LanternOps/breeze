/**
 * MUTATING. Finds every match of `query` in the document body and replaces it
 * with `replace` (default '' — i.e. delete). matchCase / matchWholeWord narrow
 * the search. Replacement is per-match `insertText(replace, 'Replace')`.
 */
import { requireString } from './helpers';

export async function findReplace(input: Record<string, unknown>): Promise<unknown> {
  const query = requireString(input, 'query');
  const replace = typeof input.replace === 'string' ? input.replace : '';
  const matchCase = input.matchCase === true;
  const matchWholeWord = input.matchWholeWord === true;

  return Word.run(async (context) => {
    const results = context.document.body.search(query, { matchCase, matchWholeWord });
    results.load('items');
    await context.sync();
    const matches = results.items;
    for (const match of matches) {
      match.insertText(replace, Word.InsertLocation.replace);
    }
    await context.sync();
    return { query, replaced: matches.length };
  });
}
