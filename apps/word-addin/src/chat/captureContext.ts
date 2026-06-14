/**
 * Word context-chip payload: the user controls per-message data egress.
 *   none      → { kind: 'none' }
 *   selection → the selected text
 *   sheet     → the WHOLE document body (Word has no sheets; we reuse the
 *               neutral 'sheet' kind to mean "the whole document")
 * Word's surface is linear text, so the payload carries `text` (additive on
 * WorkbookContext) rather than the grid-shaped `cells`/`address` Excel uses.
 */
import type { WorkbookContext, WorkbookContextKind } from '@breeze/office-addin-core';

/**
 * The open document's file name (e.g. "Proposal.docx"), captured at session
 * create so the per-user history list can tag/filter by file. Returns undefined
 * when Office.js is unavailable or the name can't be read — capture must never
 * block session creation.
 */
export async function captureWordDocumentName(): Promise<string | undefined> {
  try {
    return await Word.run(async (context) => {
      // `Document.name` exists at runtime (WordApi) but is absent from the
      // shipped @types/office-js Word.Document — read it through a load-gated cast.
      const doc = context.document as Word.Document & { name: string };
      doc.load('name');
      await context.sync();
      const name = doc.name?.trim();
      return name ? name : undefined;
    });
  } catch {
    return undefined;
  }
}

export async function captureWordContext(
  kind: WorkbookContextKind,
): Promise<WorkbookContext | undefined> {
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'selection') {
    return Word.run(async (context) => {
      const selection = context.document.getSelection();
      selection.load('text');
      await context.sync();
      return { kind: 'selection', text: selection.text ?? '' };
    });
  }
  // 'sheet' === the whole document for a grid-less host.
  return Word.run(async (context) => {
    const body = context.document.body;
    body.load('text');
    await context.sync();
    return { kind: 'sheet', text: body.text ?? '' };
  });
}
