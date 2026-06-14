/**
 * MUTATING. Appends a slide to the deck via the native PowerPointApi 1.4 path:
 * resolve a layout from the first slide master's layouts (by `layoutName`, else
 * the first layout) and call `presentation.slides.add({ slideMasterId, layoutId })`.
 *
 * When 1.4 is unavailable — or no slide master/layout can be resolved — we return
 * `{ error }` (NOT a throw): the tool layer surfaces a clean tool-result the model
 * can read and degrade from, rather than a crash or a fake success. (There is no
 * OOXML/insertSlidesFromBase64 fallback: a valid one-slide .pptx blob is large and
 * the native path covers every modern PowerPoint; shipping a stub blob would
 * silently no-op. `insert_text_box` covers placing text on the new slide.)
 */
import { isPowerPointApiSupported, optionalString, POWERPOINT_WRITE_API_SET } from './helpers';

export async function addSlide(input: Record<string, unknown>): Promise<unknown> {
  const layoutName = optionalString(input, 'layoutName');

  if (!isPowerPointApiSupported(POWERPOINT_WRITE_API_SET))
    return { error: `add_slide requires PowerPointApi ${POWERPOINT_WRITE_API_SET}` };

  return PowerPoint.run(async (context) => {
    const masters = context.presentation.slideMasters;
    masters.load('items/id');
    await context.sync();
    const master = masters.items[0];
    if (!master) return { error: 'No slide master is available in this presentation.' };

    const layouts = master.layouts;
    layouts.load('items/id,items/name');
    await context.sync();
    const layout =
      (layoutName && layouts.items.find((l) => l.name === layoutName)) || layouts.items[0];
    if (!layout) return { error: 'No slide layout is available to add a slide from.' };

    context.presentation.slides.add({ slideMasterId: master.id, layoutId: layout.id });
    await context.sync();
    return { added: true, via: 'native' };
  });
}
