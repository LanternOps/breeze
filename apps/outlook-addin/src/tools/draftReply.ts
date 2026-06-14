/**
 * Mutating tool: draft a reply to the open message. The single highest-stakes
 * Outlook action (it stages an email the user can then send), so it is
 * approval-gated by the core via OUTLOOK_MUTATING_TOOLS.
 *
 * It is MODE-DEPENDENT — `mutatingTools` is a static Set and cannot be made
 * mode-conditional, so the executor self-guards which path the live item exposes:
 *   - read mode    → the open message is immutable; draft via the reply forms
 *                    (`displayReplyAllForm` when replyAll, else `displayReplyForm`).
 *   - compose mode → the user is already drafting; write the open body directly
 *                    via `body.setAsync` (no reply form exists).
 * If neither path is present, it returns a clear `{ error }` rather than throwing
 * (e.g. a read item with the reply forms stripped).
 *
 * It re-reads `mailbox.item` at call time (via getMailboxItem) so a pinned-pane
 * item switch binds the NEW item.
 */
import { getMailboxItem } from './mailbox';
import { requireString } from './helpers';

/** Body length cap mirrors the server registry inputSchema (1..100000). */
const MAX_BODY = 100_000;

export async function draftReply(input: Record<string, unknown>): Promise<unknown> {
  const body = requireString(input, 'body');
  if (body.length > MAX_BODY) {
    throw new Error(`body must be at most ${MAX_BODY} characters`);
  }
  const replyAll = input.replyAll === true;
  const item = getMailboxItem();

  // Compose mode: write the open draft body directly. Honour the AsyncResult
  // status — resolve only on 'succeeded'; on failure reject with the host error
  // so chatController collapses it to { status:'error' } rather than reporting a
  // false success (the body was never written).
  if (typeof item.body.setAsync === 'function') {
    const setAsync = item.body.setAsync;
    await new Promise<void>((resolve, reject) => {
      setAsync(body, { coercionType: 'html' }, (result) => {
        if (result.status === 'succeeded') {
          resolve();
        } else {
          reject(new Error(result.error?.message ?? 'Failed to write the draft body (setAsync failed).'));
        }
      });
    });
    return { mode: 'compose', replyAll: false };
  }

  // Read mode: stage a reply form (all-vs-single per replyAll).
  if (replyAll && typeof item.displayReplyAllForm === 'function') {
    item.displayReplyAllForm({ htmlBody: body });
    return { mode: 'read', replyAll: true };
  }
  if (typeof item.displayReplyForm === 'function') {
    item.displayReplyForm({ htmlBody: body });
    return { mode: 'read', replyAll: false };
  }

  // Neither path available — surface a clear, non-throwing error.
  return {
    error:
      'Cannot draft a reply: the open item is neither a writable draft (compose) nor a readable message with reply forms.',
  };
}
