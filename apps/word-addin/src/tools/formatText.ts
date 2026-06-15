/**
 * MUTATING. Applies a whitelisted subset of character formatting to the current
 * selection: bold/italic, underline, font color, font size.
 *
 * `underline` is a BOOLEAN on the wire but Word's font.underline is a
 * `Word.UnderlineType` string — naive `font.underline = true` is wrong. Map
 * true → 'Single', false → 'None'.
 */
import { ToolInputError } from './helpers';

type FormatInput = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontColor?: string;
  fontSize?: number;
};

export async function formatText(input: Record<string, unknown>): Promise<unknown> {
  const raw = input.format;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ToolInputError('format must be an object');
  const format = raw as FormatInput;

  return Word.run(async (context) => {
    const selection = context.document.getSelection();
    const font = selection.font;
    const applied: string[] = [];

    if (typeof format.bold === 'boolean') {
      font.bold = format.bold;
      applied.push('bold');
    }
    if (typeof format.italic === 'boolean') {
      font.italic = format.italic;
      applied.push('italic');
    }
    if (typeof format.underline === 'boolean') {
      // bool → UnderlineType string, NOT a boolean.
      font.underline = (format.underline ? 'Single' : 'None') as Word.UnderlineType;
      applied.push('underline');
    }
    if (typeof format.fontColor === 'string') {
      font.color = format.fontColor;
      applied.push('fontColor');
    }
    if (typeof format.fontSize === 'number') {
      font.size = format.fontSize;
      applied.push('fontSize');
    }

    if (applied.length === 0)
      throw new ToolInputError(
        'format contained no supported keys (bold, italic, underline, fontColor, fontSize)',
      );
    await context.sync();
    return { applied };
  });
}
