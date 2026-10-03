/**
 * Semantic zoom and fit rules for the grouped overview (topology overview refinement, 2026-10-03).
 *
 * Tile labels are 12px in model space. Below ~0.55 zoom they render under 7px and stop being
 * text, so a card stops drawing tiles and shows a summary instead. The switch has hysteresis
 * (enter below 0.55, leave at 0.62) so a slow wheel or trackpad never flickers between the two.
 * The switch only toggles styles: nothing is laid out again and nothing moves.
 */
export const SUMMARY_ENTER_ZOOM = 0.55;
export const SUMMARY_EXIT_ZOOM = 0.62;
export type ZoomTier = 'summary' | 'detail';

export function nextZoomTier(current: ZoomTier, zoom: number): ZoomTier {
  if (current === 'detail') return zoom < SUMMARY_ENTER_ZOOM ? 'summary' : 'detail';
  return zoom >= SUMMARY_EXIT_ZOOM ? 'detail' : 'summary';
}

/**
 * How much of a summary fits a card drawn `width` × `height` screen pixels. Summaries are HTML
 * at a fixed type size, so a small card shows less rather than shrinking the text.
 */
export type SummaryDensity = 'large' | 'full' | 'compact' | 'minimal';
export function summaryDensity(width: number, height: number): SummaryDensity {
  if (width >= 560 && height >= 320) return 'large';
  if (width >= 280 && height >= 132) return 'full';
  if (width >= 150 && height >= 60) return 'compact';
  return 'minimal';
}

export type FitBox = { id: string; x1: number; y1: number; x2: number; y2: number; /** A card, or a node an edge ties to a card. */ anchor: boolean };
export type Bounds = { x1: number; y1: number; x2: number; y2: number };

/** How far from the cards an item may sit and still be part of the main structure (model px). */
const MIN_REACH = 480;
const REACH_RATIO = 0.35;

/**
 * Fit map frames the main structure, not every pixel ever drawn. The structure is the cards plus
 * anything within reach of them: max(480, 35% of the cards' larger side) in model space. That keeps
 * the gateway row and a gateway parked under a card, but leaves out a far-away legacy pin, which
 * would otherwise shrink every card to illegibility. Items left out are reported so the canvas can
 * offer "show all". Without cards (flat views) everything is framed, as before.
 */
export function fitFocus(boxes: readonly FitBox[]): { bounds: Bounds | null; outside: string[] } {
  if (!boxes.length) return { bounds: null, outside: [] };
  const union = (items: readonly FitBox[]): Bounds => ({ x1: Math.min(...items.map((b) => b.x1)), y1: Math.min(...items.map((b) => b.y1)),
    x2: Math.max(...items.map((b) => b.x2)), y2: Math.max(...items.map((b) => b.y2)) });
  const anchors = boxes.filter((box) => box.anchor);
  if (!anchors.length) return { bounds: union(boxes), outside: [] };
  const core = union(anchors);
  const reach = Math.max(MIN_REACH, REACH_RATIO * Math.max(core.x2 - core.x1, core.y2 - core.y1));
  const near = (box: FitBox) => box.x2 >= core.x1 - reach && box.x1 <= core.x2 + reach && box.y2 >= core.y1 - reach && box.y1 <= core.y2 + reach;
  const inside = boxes.filter(near);
  return { bounds: union(inside), outside: boxes.filter((box) => !near(box)).map((box) => box.id) };
}
