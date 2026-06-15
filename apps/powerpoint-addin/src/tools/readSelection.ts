/**
 * Read tool: the user's currently selected shapes as text (shape-scoped — the
 * whole shape's text, not a sub-range).
 *
 * The selected text MUST be returned under `cells: string[][]` (one shape per
 * row) — the server's per-cell DLP scan keys off `Array.isArray(output.cells)`,
 * so text under any other key downgrades DLP to a no-op. A selected shape with no
 * text frame (e.g. a picture) is counted but contributes no row (guarded, never
 * throws).
 */
export async function readSelection(_input: Record<string, unknown>): Promise<unknown> {
  return PowerPoint.run(async (context) => {
    const shapes = context.presentation.getSelectedShapes();
    shapes.load('items');
    const count = shapes.getCount();
    await context.sync();

    const shapeCount = count.value;
    // Hold the hydrated item references — re-reading `.items` after a later sync
    // would yield fresh, un-hydrated proxies.
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

    const cells = ranges.filter((r) => r !== null).map((r) => [r.text]);
    return {
      shapeCount,
      isEmpty: shapeCount === 0,
      cells,
    };
  });
}
