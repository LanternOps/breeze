/**
 * Outlook "selection" plumbing — the ONLY place the core's neutral selection
 * hook touches the mailbox object model. Mirrors the Excel/Word selection
 * modules so the core works unchanged: a one-shot label read + a change
 * subscription.
 *
 * Outlook has no cell/text selection, so the "selection address" the core's chip
 * shows is the open message SUBJECT. The "selection changed" event is the
 * mailbox ItemChanged (a pinned-pane item switch) — NOT DocumentSelectionChanged
 * (which the mail host doesn't raise). Wiring the wrong event would register
 * nothing and freeze the chip / bind the stale item.
 */
import { getMailboxItem } from '../tools/mailbox';

/**
 * One-shot read of the open message subject as the selection label. Never throws
 * — when there is no item or no subject it resolves to undefined ("no
 * selection"), so it can never block the UI.
 */
export async function captureOutlookSelectionLabel(): Promise<string | undefined> {
  try {
    const subject = getMailboxItem().subject?.trim();
    return subject ? subject : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Module-level registry of live subscriber callbacks, keyed by the mailbox
 * object currently wired to an Office-level ItemChanged handler. The mailbox's
 * `removeHandlerAsync` only removes ALL handlers for an event type — not a
 * single one — so a real per-subscriber unsubscribe can't be built on top of
 * it. Instead: attach exactly ONE Office-level handler per mailbox instance
 * (re-attaching if the mailbox object itself changes, e.g. between tests'
 * fresh mocks) and fan it out to whichever subscribers are still live.
 */
const liveSubscribers = new Set<() => void>();
let attachedMailbox: unknown = null;

/**
 * Subscribe to the mailbox ItemChanged event so the core re-reads the context
 * label (and, for a pinned pane, rebinds the active item) on every item switch.
 * Returns a REAL unsubscribe: the underlying Office handler stays attached
 * (removeHandlerAsync can't safely target just this subscriber — see above),
 * but this subscriber stops receiving dispatches immediately.
 */
export function subscribeOutlookItemChanged(cb: () => void): () => void {
  const officeGlobal = (globalThis as { Office?: typeof Office }).Office;
  const mailbox = officeGlobal?.context?.mailbox;
  const itemChanged = officeGlobal?.EventType?.ItemChanged;
  if (!mailbox || itemChanged === undefined) return () => undefined;

  liveSubscribers.add(cb);

  if (attachedMailbox !== mailbox) {
    attachedMailbox = mailbox;
    mailbox.addHandlerAsync(
      itemChanged,
      () => {
        for (const subscriber of [...liveSubscribers]) subscriber();
      },
      () => undefined,
    );
  }

  return () => {
    liveSubscribers.delete(cb);
  };
}
