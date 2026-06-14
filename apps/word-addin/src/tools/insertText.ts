/**
 * MUTATING. Inserts text relative to the current selection.
 *   location ∈ { Replace, Start, End, Before, After } — these PascalCase wire
 *   values ARE the `Word.InsertLocation` enum values (e.g.
 *   `Word.InsertLocation.end === 'End'`), so the validated string is passed
 *   straight through (no case transform).
 */
import { INSERT_LOCATIONS, ToolInputError, requireString, type InsertLocationName } from './helpers';

export async function insertText(input: Record<string, unknown>): Promise<unknown> {
  const text = requireString(input, 'text');
  const location = requireString(input, 'location');
  if (!INSERT_LOCATIONS.includes(location as InsertLocationName))
    throw new ToolInputError(
      `location must be one of ${INSERT_LOCATIONS.join(', ')} (got "${location}")`,
    );
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    // The cast covers Before/After, which the Range typings omit but selection
    // ranges accept at runtime.
    selection.insertText(text, location as Word.InsertLocation);
    await context.sync();
    return { inserted: true, location, charactersInserted: text.length };
  });
}
