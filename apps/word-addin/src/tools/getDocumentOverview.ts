/**
 * Read tool: a map of the document for the model — paragraph/word counts plus
 * the first OVERVIEW_PARAGRAPH_CAP paragraphs as text.
 *
 * Read-tool OUTPUT must carry user text under `cells: string[][]` (one paragraph
 * per row): the server's per-cell DLP scan gate is `Array.isArray(output.cells)`,
 * so text under any other key silently downgrades DLP. One paragraph per row.
 */
import { OVERVIEW_PARAGRAPH_CAP } from './helpers';

export async function getDocumentOverview(_input: Record<string, unknown>): Promise<unknown> {
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load('text');
    const paragraphs = body.paragraphs;
    paragraphs.load('items/text');
    await context.sync();
    const texts = paragraphs.items.map((p) => p.text);
    const wordCount = body.text
      .split(/\s+/)
      .filter((w) => w.length > 0).length;
    const cells = texts.slice(0, OVERVIEW_PARAGRAPH_CAP).map((t) => [t]);
    return {
      paragraphCount: texts.length,
      wordCount,
      truncated: texts.length > OVERVIEW_PARAGRAPH_CAP,
      cells,
    };
  });
}
