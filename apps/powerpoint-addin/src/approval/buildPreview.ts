/**
 * PowerPoint write-preview builder. PowerPoint edits (a new slide, a text box, a
 * font change on the selection) aren't a revertible grid, so every mutating tool
 * collapses to the `summary` WritePreview variant (a one-line description on the
 * Apply/Reject card). No before/after grid read is possible.
 */
import type { WritePreview } from '@breeze/office-addin-core';
import { optionalNonNegativeInt, optionalString, requireString } from '../tools/helpers';

export async function buildPptPreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WritePreview> {
  switch (toolName) {
    case 'add_slide': {
      const layoutName = optionalString(input, 'layoutName');
      const layoutPart = layoutName ? ` with layout "${layoutName}"` : '';
      return {
        kind: 'summary',
        toolName,
        target: layoutName ?? 'deck',
        description: `Add a slide${layoutPart}`,
      };
    }
    case 'insert_text_box': {
      const text = requireString(input, 'text');
      const slideIndex = optionalNonNegativeInt(input, 'slideIndex');
      const snippet = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      const where = slideIndex !== undefined ? `slide ${slideIndex + 1}` : 'the selected slide';
      return {
        kind: 'summary',
        toolName,
        target: where,
        description: `Insert a text box "${snippet}" on ${where}`,
      };
    }
    case 'format_selection': {
      const format = input.format;
      const keys =
        format && typeof format === 'object' && !Array.isArray(format)
          ? Object.keys(format as object).join(', ')
          : '';
      return {
        kind: 'summary',
        toolName,
        target: 'selection',
        description: `Apply formatting (${keys || 'none'}) to the selected shapes`,
      };
    }
    default:
      return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
  }
}
