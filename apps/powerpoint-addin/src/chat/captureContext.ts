/**
 * PowerPoint context-chip payload: the user controls per-message data egress.
 *   none      → { kind: 'none' }
 *   selection → the selected shapes' text
 *   sheet     → the WHOLE deck's text (PowerPoint has no sheets; we reuse the
 *               neutral 'sheet' kind to mean "the whole presentation")
 * PowerPoint's surface is shape text, so the payload carries `text` (additive on
 * WorkbookContext) rather than the grid-shaped `cells`/`address` Excel uses.
 */
import type { WorkbookContext, WorkbookContextKind } from '@breeze/office-addin-core';

/**
 * The open presentation's file name (e.g. "Deck.pptx"), captured at session
 * create so the per-user history list can tag/filter by file. Returns undefined
 * when Office.js is unavailable or the name can't be read — capture must never
 * block session creation.
 */
export async function capturePptName(): Promise<string | undefined> {
  try {
    return await PowerPoint.run(async (context) => {
      const presentation = context.presentation;
      // `Presentation.title` exists at runtime but isn't in every @types/office-js
      // build — read it through a load-gated cast.
      const p = presentation as PowerPoint.Presentation & { title: string };
      p.load('title');
      await context.sync();
      const name = p.title?.trim();
      return name ? name : undefined;
    });
  } catch {
    return undefined;
  }
}

/** Read the text of every selected shape that carries a text frame, in order. */
async function readSelectedShapeText(): Promise<string> {
  return PowerPoint.run(async (context) => {
    const shapes = context.presentation.getSelectedShapes();
    shapes.load('items');
    await context.sync();
    const items = [...shapes.items];
    for (const shape of items) shape.textFrame.load('hasText');
    await context.sync();
    const ranges = items.map((shape) => {
      if (!shape.textFrame.hasText) return null;
      const range = shape.textFrame.textRange;
      range.load('text');
      return range;
    });
    await context.sync();
    return ranges
      .filter((r) => r !== null)
      .map((r) => r.text)
      .join('\n');
  });
}

/** Read the text of every shape on every slide in deck order. */
async function readDeckText(): Promise<string> {
  return PowerPoint.run(async (context) => {
    const slides = context.presentation.slides;
    slides.load('items');
    await context.sync();
    const shapeColls = slides.items.map((slide) => {
      const shapes = slide.shapes;
      shapes.load('items');
      return shapes;
    });
    await context.sync();
    const allShapes = shapeColls.flatMap((c) => [...c.items]);
    for (const shape of allShapes) shape.textFrame.load('hasText');
    await context.sync();
    const ranges = allShapes.map((shape) => {
      if (!shape.textFrame.hasText) return null;
      const range = shape.textFrame.textRange;
      range.load('text');
      return range;
    });
    await context.sync();
    return ranges
      .filter((r) => r !== null)
      .map((r) => r.text)
      .join('\n');
  });
}

export async function capturePptContext(
  kind: WorkbookContextKind,
): Promise<WorkbookContext | undefined> {
  if (kind === 'none') return { kind: 'none' };
  if (kind === 'selection') {
    return { kind: 'selection', text: await readSelectedShapeText() };
  }
  // 'sheet' === the whole presentation for a grid-less host.
  return { kind: 'sheet', text: await readDeckText() };
}
