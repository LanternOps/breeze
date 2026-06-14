/**
 * Outlook write-preview builder. The only mutating tool is draft_reply, and an
 * email draft has no before/after grid, so it uses the `text` WritePreview
 * variant: the full reply prose is shown on the Apply/Reject card so the user
 * approves the ACTUAL email body (not a one-line summary) before it is staged —
 * this is the highest-stakes action in the host. Any unknown tool still
 * collapses to the generic `summary` variant.
 */
import type { WritePreview } from '@breeze/office-addin-core';
import { requireString } from '../tools/helpers';

export async function buildOutlookPreview(
  toolName: string,
  input: Record<string, unknown>,
): Promise<WritePreview> {
  if (toolName === 'draft_reply') {
    const body = requireString(input, 'body');
    const replyAll = input.replyAll === true;
    return {
      kind: 'text',
      toolName,
      target: replyAll ? 'Reply all' : 'Reply',
      after: body,
    };
  }
  return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
}
