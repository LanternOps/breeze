/**
 * PowerPoint selection plumbing — the ONLY place the selection chip touches the
 * `PowerPoint.*` / `Office.context` object model. Mirrors Word's
 * host/wordSelection so the core's neutral selection hook works unchanged: a
 * one-shot label read + a change subscription.
 *
 * PowerPoint has no cell address, so the "selection address" the core shows is a
 * short snippet of the selected shape's text — or, when slides (not shapes) are
 * selected, a slide locator like "Slide 2". Both functions are wired into the
 * PowerPoint HostAdapter (host/powerpoint.ts).
 */

/** Max characters of selected shape text shown in the chip before truncation. */
const SELECTION_LABEL_CAP = 60;

/**
 * One-shot read of the current selection as a short label. Never throws — a
 * failed read or empty selection resolves to undefined ("no selection"), so it
 * can never block the UI.
 */
export async function capturePptSelectionLabel(): Promise<string | undefined> {
  try {
    return await PowerPoint.run(async (context) => {
      const presentation = context.presentation;
      const shapes = presentation.getSelectedShapes();
      shapes.load('items');
      const shapeCount = shapes.getCount();
      const slides = presentation.slides;
      slides.load('items/id');
      const selectedSlides = presentation.getSelectedSlides();
      selectedSlides.load('items/id');
      await context.sync();

      if (shapeCount.value > 0) {
        const first = shapes.items[0];
        first.textFrame.load('hasText');
        await context.sync();
        if (first.textFrame.hasText) {
          const range = first.textFrame.textRange;
          range.load('text');
          await context.sync();
          const text = range.text?.trim();
          if (text)
            return text.length > SELECTION_LABEL_CAP
              ? `${text.slice(0, SELECTION_LABEL_CAP)}…`
              : text;
        }
      }

      // No shape text — fall back to a slide locator.
      if (selectedSlides.items.length > 0) {
        const deckIds = slides.items.map((s) => s.id);
        const idx = deckIds.indexOf(selectedSlides.items[0].id);
        if (idx >= 0) return `Slide ${idx + 1}`;
      }
      return undefined;
    });
  } catch {
    return undefined;
  }
}

/**
 * Subscribe to PowerPoint's `DocumentSelectionChanged` so the core can re-read
 * the selection label on every change. Mirrors Word: returns a no-op unsubscribe
 * (the always-mounted subscriber guards late updates itself).
 */
export function subscribePptSelectionChanged(cb: () => void): () => void {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  officeGlobal?.context?.document?.addHandlerAsync(
    officeGlobal.EventType.DocumentSelectionChanged,
    cb,
    () => undefined,
  );
  return () => undefined;
}
