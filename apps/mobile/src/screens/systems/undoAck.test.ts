import { describe, expect, it } from 'vitest';

import {
  cancelUndo,
  emptyUndo,
  flushAllUndo,
  flushUndo,
  scheduleUndo,
  undoToastLabel,
} from './undoAck';

describe('undo window', () => {
  it('holds the ids instead of sending them', () => {
    const { state, flush, token } = scheduleUndo(emptyUndo, ['a', 'b']);
    // Nothing is released by scheduling: that IS the feature. An acknowledge
    // cannot be reversed, so the request must not exist yet.
    expect(flush).toEqual([]);
    expect(state.batch).toEqual({ token, ids: ['a', 'b'] });
  });

  it('releases the ids when the window closes', () => {
    const s = scheduleUndo(emptyUndo, ['a']);
    const { state, ids } = flushUndo(s.state, s.token);
    expect(ids).toEqual(['a']);
    expect(state.batch).toBeNull();
  });

  it('never sends the ids when undone', () => {
    const s = scheduleUndo(emptyUndo, ['a', 'b']);
    const { state, ids } = cancelUndo(s.state, s.token);
    // Returned so the caller can un-hide them; the request is simply not made.
    expect(ids).toEqual(['a', 'b']);
    expect(state.batch).toBeNull();
  });
});

describe('one window at a time (one toast, one timer)', () => {
  it('flushes the previous batch rather than stacking a second toast', () => {
    const first = scheduleUndo(emptyUndo, ['a']);
    const second = scheduleUndo(first.state, ['b']);

    // The earlier acknowledge is now committed — the operator moved on.
    expect(second.flush).toEqual(['a']);
    expect(second.state.batch).toEqual({ token: second.token, ids: ['b'] });
    expect(second.token).not.toBe(first.token);
  });

  it('a 30-alert selection is ONE batch, not 30', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `alert-${i}`);
    const { state, flush } = scheduleUndo(emptyUndo, ids);
    expect(flush).toEqual([]);
    expect(state.batch?.ids).toHaveLength(30);
  });

  it('scheduling nothing does not disturb an open window', () => {
    const first = scheduleUndo(emptyUndo, ['a']);
    const noop = scheduleUndo(first.state, []);
    expect(noop.flush).toEqual([]);
    expect(noop.state).toBe(first.state);
  });
});

describe('stale events release nothing', () => {
  // A timer, an undo tap and an unmount can all fire against a window that has
  // already closed. Acting on a stale one is the dangerous case: it either
  // sends a batch the operator undid, or un-hides rows whose request is already
  // in flight — showing an active alert that is about to be acknowledged.

  it('a timer that fires after undo sends nothing', () => {
    const s = scheduleUndo(emptyUndo, ['a']);
    const undone = cancelUndo(s.state, s.token);
    const late = flushUndo(undone.state, s.token);
    expect(late.ids).toEqual([]);
  });

  it('an undo tap after the window already flushed restores nothing', () => {
    const s = scheduleUndo(emptyUndo, ['a']);
    const flushed = flushUndo(s.state, s.token);
    const late = cancelUndo(flushed.state, s.token);
    expect(late.ids).toEqual([]);
  });

  it("the replaced batch's timer cannot flush the batch that replaced it", () => {
    const first = scheduleUndo(emptyUndo, ['a']);
    const second = scheduleUndo(first.state, ['b']);
    // first's timer is still pending and now fires
    const late = flushUndo(second.state, first.token);
    expect(late.ids).toEqual([]);
    expect(late.state.batch?.ids).toEqual(['b']);
  });

  it("the replaced batch's undo cannot cancel the batch that replaced it", () => {
    const first = scheduleUndo(emptyUndo, ['a']);
    const second = scheduleUndo(first.state, ['b']);
    const late = cancelUndo(second.state, first.token);
    expect(late.ids).toEqual([]);
    expect(late.state.batch?.ids).toEqual(['b']);
  });
});

describe('leaving the screen flushes, never cancels', () => {
  it('sends a held batch on unmount', () => {
    // Dropping it would make swipe-then-navigate silently do nothing.
    const s = scheduleUndo(emptyUndo, ['a', 'b']);
    const { state, ids } = flushAllUndo(s.state);
    expect(ids).toEqual(['a', 'b']);
    expect(state.batch).toBeNull();
  });

  it('is a no-op with no window open', () => {
    expect(flushAllUndo(emptyUndo).ids).toEqual([]);
  });

  it('does not re-send after an undo', () => {
    const s = scheduleUndo(emptyUndo, ['a']);
    const undone = cancelUndo(s.state, s.token);
    expect(flushAllUndo(undone.state).ids).toEqual([]);
  });
});

describe('undoToastLabel', () => {
  it('is singular for one', () => {
    expect(undoToastLabel(1)).toBe('Alert acknowledged');
  });
  it('is plural beyond one', () => {
    expect(undoToastLabel(3)).toBe('3 alerts acknowledged');
  });
});
