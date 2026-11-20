// View-only mode (#8241): a viewer-local guard against accidental input. No
// agent message exists for it, by design — the remote is untouched and the
// operator simply stops sending.
//
// The gate sits on the outgoing sender (both `input` and `input-r`, before the
// reliable-input router assigns a seq) and on the RAF mouse-move flush.
// Releases still pass: view-only is engaged by releasing everything held first,
// and a release that arrives later (a stranded one flushed on reconnect) must
// never be the event that gets dropped — a dropped release is a latched key.

type InputEventLike = { type?: unknown; [field: string]: unknown };

export function isReleaseEvent(event: InputEventLike): boolean {
  return event.type === 'key_up' || event.type === 'mouse_up';
}

/** True when `event` must not leave the viewer. */
export function suppressedByViewOnly(event: InputEventLike, viewOnly: boolean): boolean {
  return viewOnly && !isReleaseEvent(event);
}
