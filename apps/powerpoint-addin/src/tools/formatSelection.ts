/**
 * MUTATING. Applies a whitelisted subset of character formatting to the text of
 * every currently selected shape: bold/italic, underline, font color, font size.
 *
 * Gated on PowerPointApi 1.4 (font setters live there) — when 1.4 is unavailable
 * we return `{ error }` (NOT a throw), so the tool layer surfaces it as a clean
 * tool-result for the model.
 *
 * `underline` is a BOOLEAN on the wire but PowerPoint's font.underline is a
 * `PowerPoint.ShapeFontUnderlineStyle` string — naive `font.underline = true` is
 * wrong. Map true → 'Single', false → 'None'.
 *
 * A selected shape with no text frame (a picture) is skipped (guarded). Throws
 * ToolInputError when `format` is not an object or carries no supported keys.
 */
import {
  isPowerPointApiSupported,
  POWERPOINT_WRITE_API_SET,
  ToolInputError,
} from './helpers';

type FormatInput = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontColor?: string;
  fontSize?: number;
};

export async function formatSelection(input: Record<string, unknown>): Promise<unknown> {
  const raw = input.format;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('format must be an object');
  const format = raw as FormatInput;

  const requested: string[] = [];
  if (typeof format.bold === 'boolean') requested.push('bold');
  if (typeof format.italic === 'boolean') requested.push('italic');
  if (typeof format.underline === 'boolean') requested.push('underline');
  if (typeof format.fontColor === 'string') requested.push('fontColor');
  if (typeof format.fontSize === 'number') requested.push('fontSize');
  if (requested.length === 0)
    throw new ToolInputError(
      'format contained no supported keys (bold, italic, underline, fontColor, fontSize)',
    );

  if (!isPowerPointApiSupported(POWERPOINT_WRITE_API_SET))
    return { error: `format_selection requires PowerPointApi ${POWERPOINT_WRITE_API_SET}` };

  return PowerPoint.run(async (context) => {
    const shapes = context.presentation.getSelectedShapes();
    shapes.load('items');
    await context.sync();

    // Hold the hydrated item references — re-reading `.items` after the next sync
    // would yield fresh, un-hydrated proxies.
    const items = [...shapes.items];
    for (const shape of items) shape.textFrame.load('hasText');
    await context.sync();

    const applied = new Set<string>();
    for (const shape of items) {
      if (!shape.textFrame.hasText) continue; // skip shapes with no text frame
      const font = shape.textFrame.textRange.font;
      if (typeof format.bold === 'boolean') {
        font.bold = format.bold;
        applied.add('bold');
      }
      if (typeof format.italic === 'boolean') {
        font.italic = format.italic;
        applied.add('italic');
      }
      if (typeof format.underline === 'boolean') {
        // bool → ShapeFontUnderlineStyle string, NOT a boolean.
        font.underline = (
          format.underline ? 'Single' : 'None'
        ) as PowerPoint.ShapeFontUnderlineStyle;
        applied.add('underline');
      }
      if (typeof format.fontColor === 'string') {
        font.color = format.fontColor;
        applied.add('fontColor');
      }
      if (typeof format.fontSize === 'number') {
        font.size = format.fontSize;
        applied.add('fontSize');
      }
    }

    await context.sync();
    // Preserve the input key order (bold, italic, underline, fontColor, fontSize).
    return { applied: requested.filter((k) => applied.has(k)) };
  });
}
