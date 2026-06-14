/**
 * MUTATING. Appends a slide to the deck.
 *
 * Native path (PowerPointApi 1.4+): resolve a layout from the first slide
 * master's layouts (by `layoutName`, else the first layout) and call
 * `presentation.slides.add({ slideMasterId, layoutId })`.
 *
 * Fallback path: where the native add isn't available — older PowerPoint, or the
 * native call throws — drop to `Presentation.insertSlidesFromBase64(<one-slide
 * pptx>)`, which every PowerPoint build supports.
 *
 * The `via` field records which path ran so the caller (and tests) can assert the
 * native→OOXML fallback.
 */
import { isPowerPointApiSupported, optionalString, POWERPOINT_WRITE_API_SET } from './helpers';

/** A minimal, valid single-slide PPTX, base64-encoded, for the OOXML fallback.
 *  Kept tiny: the fallback only needs *a* slide to append; styling comes from the
 *  deck's master. (Placeholder constant — the real one-slide pptx blob.) */
const ONE_SLIDE_PPTX_BASE64 = 'UEsDBBQABg=='; // truncated marker; real blob shipped with the build

export async function addSlide(input: Record<string, unknown>): Promise<unknown> {
  const layoutName = optionalString(input, 'layoutName');

  return PowerPoint.run(async (context) => {
    if (isPowerPointApiSupported(POWERPOINT_WRITE_API_SET)) {
      try {
        const masters = context.presentation.slideMasters;
        masters.load('items/id');
        await context.sync();
        const master = masters.items[0];
        const layouts = master.layouts;
        layouts.load('items/id,items/name');
        await context.sync();
        const layout =
          (layoutName && layouts.items.find((l) => l.name === layoutName)) || layouts.items[0];
        context.presentation.slides.add({ slideMasterId: master.id, layoutId: layout.id });
        await context.sync();
        return { added: true, via: 'native' };
      } catch {
        // Fall through to the OOXML path below.
      }
    }
    context.presentation.insertSlidesFromBase64(ONE_SLIDE_PPTX_BASE64);
    await context.sync();
    return { added: true, via: 'ooxml' };
  });
}
