/**
 * Outlook write-preview builder. The only mutating tool is draft_reply, and an
 * email draft has no before/after grid, so it collapses to the `summary`
 * WritePreview variant (the draft body on the Apply/Reject card).
 *
 * NOTE: `summary` is a deliberately weak card for a multi-paragraph email (the
 * highest-stakes action — staging an email to send). A richer `{ kind: 'text' }`
 * variant that shows the full body is a noted fast-follow (see the plan's TOP
 * RISKS); the baseline summary is acceptable.
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
    const snippet = body.length > 80 ? `${body.slice(0, 80)}…` : body;
    return {
      kind: 'summary',
      toolName,
      target: replyAll ? 'Reply all' : 'Reply',
      description: `Draft a ${replyAll ? 'reply-all' : 'reply'}: "${snippet}"`,
    };
  }
  return { kind: 'summary', toolName, target: '', description: `Run ${toolName}` };
}
