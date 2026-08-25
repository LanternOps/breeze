import { describe, it, expect } from 'vitest';

import {
  beginAck,
  bulkActionLabel,
  emptyPendingAcks,
  endAck,
  isPending,
  reconcileSelection,
  toggleSelection,
  visibleAlerts,
} from './pendingAcks';
import type { Alert } from '../../services/api';

const alert = (id: string) => ({ id } as unknown as Alert);
const list = [alert('a'), alert('b'), alert('c')];

describe('optimistic acknowledge bookkeeping', () => {
  it('hides rows the moment an acknowledge starts', () => {
    // The write takes 13-15s server-side; waiting on it makes triage unusable.
    const state = beginAck(emptyPendingAcks, ['b']);
    expect(visibleAlerts(list, state).map((a) => a.id)).toEqual(['a', 'c']);
    expect(isPending(state, 'b')).toBe(true);
  });

  it('restores rows when the request ends', () => {
    const started = beginAck(emptyPendingAcks, ['a', 'b']);
    const ended = endAck(started, ['a', 'b']);
    expect(visibleAlerts(list, ended)).toHaveLength(3);
  });

  it('restores only the ids it is given, leaving other in-flight rows hidden', () => {
    const started = beginAck(emptyPendingAcks, ['a', 'b']);
    const partial = endAck(started, ['a']);
    expect(visibleAlerts(list, partial).map((x) => x.id)).toEqual(['a', 'c']);
  });

  it('never mutates the state it is given', () => {
    const start = beginAck(emptyPendingAcks, ['a']);
    const after = beginAck(start, ['b']);
    expect([...start.pending.keys()]).toEqual(['a']);
    expect([...after.pending.keys()].sort()).toEqual(['a', 'b']);
  });

  it('returns the same list reference when nothing is pending', () => {
    expect(visibleAlerts(list, emptyPendingAcks)).toEqual(list);
  });

  it('treats an empty id list as a no-op in both directions', () => {
    expect(beginAck(emptyPendingAcks, [])).toBe(emptyPendingAcks);
    expect(endAck(emptyPendingAcks, [])).toBe(emptyPendingAcks);
  });
});

describe('toggleSelection', () => {
  it('adds then removes, without mutating the input', () => {
    const first = toggleSelection(new Set<string>(), 'x');
    expect([...first]).toEqual(['x']);
    const second = toggleSelection(first, 'x');
    expect([...second]).toEqual([]);
    expect([...first]).toEqual(['x']);
  });
});

describe('bulkActionLabel', () => {
  it('only pluralises when there is more than one', () => {
    expect(bulkActionLabel(0)).toBe('Acknowledge alert');
    expect(bulkActionLabel(1)).toBe('Acknowledge alert');
    expect(bulkActionLabel(2)).toBe('Acknowledge 2 alerts');
  });
});


describe('reference counting', () => {
  it('keeps a row hidden until the LAST overlapping request ends', () => {
    // A plain set un-hid the row when the first of two finished, flashing an
    // alert back while its second request was still running.
    let state = beginAck(emptyPendingAcks, ['a']);
    state = beginAck(state, ['a']);
    state = endAck(state, ['a']);
    expect(isPending(state, 'a')).toBe(true);
    state = endAck(state, ['a']);
    expect(isPending(state, 'a')).toBe(false);
  });

  it('ignores an end for an id that was never started', () => {
    const state = endAck(emptyPendingAcks, ['ghost']);
    expect(isPending(state, 'ghost')).toBe(false);
  });
});

describe('reconcileSelection', () => {
  it('drops ids whose rows are gone', () => {
    // Another operator may have acknowledged one; submitting it would be
    // silently skipped while the UI claimed success.
    const selected = new Set(['a', 'gone', 'c']);
    const visible = [{ id: 'a' }, { id: 'c' }];
    expect([...reconcileSelection(selected, visible)].sort()).toEqual(['a', 'c']);
  });

  it('returns empty when nothing selected is still visible', () => {
    expect([...reconcileSelection(new Set(['x']), [{ id: 'y' }])]).toEqual([]);
  });

  it('does not mutate the input selection', () => {
    const selected = new Set(['a', 'b']);
    reconcileSelection(selected, [{ id: 'a' }]);
    expect([...selected].sort()).toEqual(['a', 'b']);
  });
});
