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
export type SummaryDensity = 'large' | 'full' | 'compact';
/** Title, subtitle and agent presence always show; only the role chips give way (`compact`), and a summary too big for its card shrinks or overhangs (summaryScale). */
export function summaryDensity(width: number, height: number): SummaryDensity {
  if (width >= 560 && height >= 320) return 'large';
  if (width >= 280 && height >= 132) return 'full';
  return 'compact';
}

export type FitBox = { id: string; x1: number; y1: number; x2: number; y2: number; /** A card: the cards define the main structure. */ anchor: boolean };
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

/**
 * Zoomed out, a card's box recedes and its summary panel is the visible object. Each card gets an
 * invisible anchor node sized and placed to match its panel, and an edge's card end moves to that
 * anchor, so lines meet the panel rather than stopping at a faint box border.
 */
export const summaryAnchorId = (cardId: string) => `anchor:${cardId}`;
export const edgeEnd = (end: string, cards: ReadonlySet<string>, tier: ZoomTier) => tier === 'summary' && cards.has(end) ? summaryAnchorId(end) : end;

/** A screen-space rectangle (relative to the canvas) as a model-space centre and size. */
export function screenRectToModel(rect: { left: number; top: number; width: number; height: number }, pan: { x: number; y: number }, zoom: number) {
  return { x: (rect.left + rect.width / 2 - pan.x) / zoom, y: (rect.top + rect.height / 2 - pan.y) / zoom, width: rect.width / zoom, height: rect.height / zoom };
}

/**
 * Scale for a summary panel in a card drawn `boxW` × `boxH` screen px. A panel may overhang its
 * (receded) box by 8px a side; beyond that it shrinks to fit, but never under 0.8, where its type
 * would stop reading. Past the floor it overhangs: the box has receded, the panel is the card.
 */
export function summaryScale(panelW: number, panelH: number, boxW: number, boxH: number): number {
  if (!panelW || !panelH) return 1;
  return Math.max(0.8, Math.min(1, (boxW + 16) / panelW, (boxH + 16) / panelH));
}

/**
 * Canvas height that fills the window below the canvas's top edge (measured with the page scrolled
 * to the top), less the page's bottom gutter, and never under `min` (480px): the map uses the screen
 * it has instead of a fixed height that either leaves empty page or pushes the map under the fold.
 */
export function canvasFillHeight({ viewportHeight, canvasTop, bottomGap, min = 480 }: { viewportHeight: number; canvasTop: number; bottomGap: number; min?: number }): number {
  return Math.max(min, Math.floor(viewportHeight - canvasTop - bottomGap));
}

/**
 * Where a card's summary may sit: the part of the card's drawn box that is on screen (null when none
 * is). The overlay pins the summary to the top of this slot, horizontally centred, so it sits where
 * the card title was and stays in view when the card's top is scrolled off.
 */
export function summarySlot(box: { x1: number; y1: number; x2: number; y2: number }, width: number, height: number) {
  const x1 = Math.max(box.x1, 0), y1 = Math.max(box.y1, 0), x2 = Math.min(box.x2, width), y2 = Math.min(box.y2, height);
  return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null;
}

/**
 * How much each zoomed-out node chip shows (NodeChipOverlay). `full`: glyph, label and detail;
 * `compact` (icon plus address) once the node itself draws narrower than 120px; `icon` only as a
 * last resort. Chips that would overlap (with an 8px margin) both step down until they clear, so on a
 * narrow screen two gateways never print over each other. A chip is never smaller than its node.
 */
export type ChipMode = 'full' | 'compact' | 'icon';
export function chipModes(chips: readonly { id: string; x: number; y: number; nodeW: number; nodeH: number; fullW: number; compactW: number }[]): Map<string, ChipMode> {
  const order: ChipMode[] = ['full', 'compact', 'icon'];
  const mode = new Map(chips.map((chip) => [chip.id, (chip.nodeW < 120 ? 'compact' : 'full') as ChipMode]));
  const size = (chip: typeof chips[number]) => {
    const m = mode.get(chip.id)!;
    return { w: Math.max(chip.nodeW, m === 'full' ? chip.fullW : m === 'compact' ? chip.compactW : 34), h: Math.max(chip.nodeH, m === 'full' ? 44 : 32) };
  };
  for (let pass = 0; pass < order.length; pass++) {
    let changed = false;
    for (let i = 0; i < chips.length; i++) for (let j = i + 1; j < chips.length; j++) {
      const a = chips[i]!, b = chips[j]!, sa = size(a), sb = size(b);
      const overlap = Math.abs(a.x - b.x) < (sa.w + sb.w) / 2 + 8 && Math.abs(a.y - b.y) < (sa.h + sb.h) / 2 + 8;
      if (!overlap) continue;
      for (const chip of [a, b]) {
        const next = order[Math.min(order.length - 1, order.indexOf(mode.get(chip.id)!) + 1)]!;
        if (next !== mode.get(chip.id)) { mode.set(chip.id, next); changed = true; }
      }
    }
    if (!changed) break;
  }
  return mode;
}
