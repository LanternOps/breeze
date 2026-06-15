/**
 * Read tool: the user's current selection as text.
 *
 * The selected text MUST be returned under `cells: string[][]` (one paragraph
 * per row) — the server's per-cell DLP scan keys off `Array.isArray(output.cells)`,
 * so text under any other key downgrades DLP to a no-op.
 */
export async function readSelection(_input: Record<string, unknown>): Promise<unknown> {
  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    selection.load('text');
    const paragraphs = selection.paragraphs;
    paragraphs.load('items/text');
    await context.sync();
    const isEmpty = selection.text.length === 0;
    const texts = isEmpty ? [] : paragraphs.items.map((p) => p.text);
    return {
      paragraphCount: texts.length,
      isEmpty,
      cells: texts.map((t) => [t]),
    };
  });
}
