/**
 * MUTATING. Inserts a new text box onto a slide.
 *
 * `addTextBox` is a PowerPointApi 1.4 capability — when 1.4 is unavailable we
 * return `{ error }` (NOT a throw): the tool layer surfaces it as a clean
 * tool-result the model can read, rather than a crash.
 *
 * Targets `slideIndex` when given (non-negative integer); otherwise the first
 * selected slide; otherwise the first slide in the deck.
 */
import {
  isPowerPointApiSupported,
  optionalNonNegativeInt,
  POWERPOINT_WRITE_API_SET,
  requireString,
} from './helpers';

export async function insertTextBox(input: Record<string, unknown>): Promise<unknown> {
  const text = requireString(input, 'text');
  const slideIndex = optionalNonNegativeInt(input, 'slideIndex');

  if (!isPowerPointApiSupported(POWERPOINT_WRITE_API_SET))
    return { error: `insert_text_box requires PowerPointApi ${POWERPOINT_WRITE_API_SET}` };

  return PowerPoint.run(async (context) => {
    const presentation = context.presentation;
    const slides = presentation.slides;
    slides.load('items/id');
    const selected = presentation.getSelectedSlides();
    selected.load('items/id');
    await context.sync();

    let targetIndex: number;
    if (slideIndex !== undefined) {
      targetIndex = slideIndex;
    } else if (selected.items.length > 0) {
      const deckIds = slides.items.map((s) => s.id);
      targetIndex = Math.max(0, deckIds.indexOf(selected.items[0].id));
    } else {
      targetIndex = 0;
    }

    const slide = slides.items[targetIndex];
    slide.shapes.addTextBox(text);
    await context.sync();
    return { inserted: true, slideIndex: targetIndex };
  });
}
