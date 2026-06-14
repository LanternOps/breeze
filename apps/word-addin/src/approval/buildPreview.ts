/**
 * Word write-preview builder. Word edits are linear text, not a grid, so every
 * mutating tool collapses to the `summary` WritePreview variant (a one-line
 * description on the Apply/Reject card). No before/after grid read is possible.
 */
import type { WritePreview } from '@breeze/office-addin-core';
import { optionalString, requireString } from '../tools/helpers';

export async function buildWordPreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WritePreview> {
  switch (toolName) {
    case 'insert_text': {
      const text = requireString(input, 'text');
      const location = requireString(input, 'location');
      const snippet = text.length > 60 ? `${text.slice(0, 60)}…` : text;
      return {
        kind: 'summary',
        toolName,
        target: location,
        description: `Insert "${snippet}" at ${location} of the selection`,
      };
    }
    case 'format_text': {
      const format = input.format;
      const keys =
        format && typeof format === 'object' && !Array.isArray(format)
          ? Object.keys(format as object).join(', ')
          : '';
      return {
        kind: 'summary',
        toolName,
        target: 'selection',
        description: `Apply formatting (${keys || 'none'}) to the selection`,
      };
    }
    case 'find_replace': {
      const query = requireString(input, 'query');
      const replace = optionalString(input, 'replace') ?? '';
      return {
        kind: 'summary',
        toolName,
        target: query,
        description: `Replace all "${query}" with "${replace}"`,
      };
    }
    default:
      return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
  }
}
