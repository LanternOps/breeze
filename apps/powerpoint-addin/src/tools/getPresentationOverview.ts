/**
 * Read tool: a map of the deck for the model — slide count, the selected slide
 * index, and the title text of each slide (the first shape's text).
 *
 * Read-tool OUTPUT must carry user text under `cells: string[][]` (one slide
 * title per row): the server's per-cell DLP scan gate is
 * `Array.isArray(output.cells)`, so text under any other key silently downgrades
 * DLP. PowerPoint shapes can lack a text frame entirely (a picture), so the title
 * read guards `textFrame.hasText` and never throws.
 */
import { OVERVIEW_SLIDE_CAP } from './helpers';

export async function getPresentationOverview(_input: Record<string, unknown>): Promise<unknown> {
  return PowerPoint.run(async (context) => {
    const presentation = context.presentation;
    const slides = presentation.slides;
    slides.load('items/id');
    const selected = presentation.getSelectedSlides();
    selected.load('items/id');
    await context.sync();

    const slideCount = slides.items.length;
    const deckIds = slides.items.map((s) => s.id);
    const firstSelectedId = selected.items.length > 0 ? selected.items[0].id : null;
    const selectedSlideIndex = firstSelectedId === null ? -1 : deckIds.indexOf(firstSelectedId);

    // The title is shapes[0]; guard textFrame.hasText before reading its text.
    const capped = slides.items.slice(0, OVERVIEW_SLIDE_CAP);
    const shapeColls = capped.map((slide) => {
      const shapes = slide.shapes;
      shapes.load('items');
      return shapes;
    });
    await context.sync();

    const titles = shapeColls.map((shapes) => {
      const title = shapes.items[0];
      if (!title) return null;
      title.textFrame.load('hasText');
      return title;
    });
    await context.sync();

    const ranges = titles.map((title) => {
      if (!title || !title.textFrame.hasText) return null;
      const range = title.textFrame.textRange;
      range.load('text');
      return range;
    });
    await context.sync();

    const cells = ranges.map((range) => [range ? range.text : '']);

    return {
      slideCount,
      selectedSlideIndex,
      truncated: slideCount > OVERVIEW_SLIDE_CAP,
      cells,
    };
  });
}
