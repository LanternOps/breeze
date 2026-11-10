/**
 * The ticket queue's single-key shortcuts. `useQueueKeyboard` dispatches from
 * this table and the `?` cheat sheet (KeyboardShortcutsHelp) renders it, so the
 * card can never advertise a key that does nothing. `keys` are
 * `KeyboardEvent.key` values; labels live in the `common` namespace beside the
 * rest of the cheat sheet.
 */
export type QueueAction = 'next' | 'previous' | 'open' | 'assignMe' | 'reply' | 'internal' | 'resolve' | 'toggleBulk';

export interface QueueShortcut {
  action: QueueAction;
  keys: readonly string[];
  labelKey: string;
}

export const QUEUE_SHORTCUTS: readonly QueueShortcut[] = [
  { action: 'next', keys: ['j', 'ArrowDown'], labelKey: 'layout.shortcuts.queue.next' },
  { action: 'previous', keys: ['k', 'ArrowUp'], labelKey: 'layout.shortcuts.queue.previous' },
  { action: 'open', keys: ['Enter', 'o'], labelKey: 'layout.shortcuts.queue.open' },
  { action: 'toggleBulk', keys: ['x'], labelKey: 'layout.shortcuts.queue.toggleBulk' },
  { action: 'assignMe', keys: ['a'], labelKey: 'layout.shortcuts.queue.assignMe' },
  { action: 'reply', keys: ['r'], labelKey: 'layout.shortcuts.queue.reply' },
  { action: 'internal', keys: ['n'], labelKey: 'layout.shortcuts.queue.internal' },
  { action: 'resolve', keys: ['e'], labelKey: 'layout.shortcuts.queue.resolve' },
];

/** How a key is printed on the cheat sheet. */
export function queueKeyLabel(key: string): string {
  if (key === 'ArrowDown') return '↓';
  if (key === 'ArrowUp') return '↑';
  return key;
}
