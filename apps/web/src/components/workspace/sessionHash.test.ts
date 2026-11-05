/**
 * #9840 W3 (Task 12): `#session=<uuid>` parsing and writing (D6, Review Focus 5).
 * Anything that is not exactly one canonical UUID is ignored (no fetch follows);
 * upper case is normalised. The writer keeps Astro's ClientRouter data in
 * history.state (see components/shared/HashLink.tsx).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSessionHash, toastForOpenResult, writeSessionHash } from './sessionHash';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('parseSessionHash', () => {
  it.each([
    [`session=${ID}`, ID],
    [`session=${ID.toUpperCase()}`, ID],
    [`session=0F8FAD5B-d9cb-469F-a165-70867728950E`, ID],
  ])('accepts %s', (raw, expected) => {
    expect(parseSessionHash(raw)).toBe(expected);
  });

  it.each([
    [''],
    [ID],
    [`#session=${ID}`],
    ['session='],
    ['session=../x'],
    ['session=../../ai/sessions'],
    [`session=${ID}&x=1`],
    [`session=${ID}?x=1`],
    [`session=${ID}/x`],
    [`session=${ID}&session=${ID}`],
    [`session=${ID}session=${ID}`],
    [`x=1&session=${ID}`],
    [`session=${ID} `],
    [` session=${ID}`],
    [`session=${ID.slice(0, -1)}`],
    [`session=${ID}0`],
    [`session=${ID.replace(/-/g, '')}`],
    [`session=%7B${ID}%7D`],
    [`session=${encodeURIComponent(ID)}%00`],
    [`Session=${ID}`],
    ['session=not-a-uuid'],
    [`activity=${ID}`],
  ])('rejects %j', (raw) => {
    expect(parseSessionHash(raw)).toBeUndefined();
  });
});

describe('writeSessionHash', () => {
  beforeEach(() => {
    window.history.replaceState({ astro: 'router-data' }, '', '/ai/chat?x=1');
  });
  afterEach(() => vi.restoreAllMocks());

  it('replaces (never pushes) and passes the existing history.state through', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    const push = vi.spyOn(window.history, 'pushState');
    const length = window.history.length;
    writeSessionHash(ID);
    expect(replace).toHaveBeenCalledWith({ astro: 'router-data' }, '', `/ai/chat?x=1#session=${ID}`);
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe(`#session=${ID}`);
    expect(window.history.length).toBe(length);
    expect(window.history.state).toEqual({ astro: 'router-data' });
  });

  it('null clears the fragment and keeps path + query', () => {
    writeSessionHash(ID);
    const replace = vi.spyOn(window.history, 'replaceState');
    writeSessionHash(null);
    expect(replace).toHaveBeenCalledWith({ astro: 'router-data' }, '', '/ai/chat?x=1');
    expect(window.location.hash).toBe('');
  });

  it('is a no-op when the hash already says the same thing', () => {
    writeSessionHash(ID);
    const replace = vi.spyOn(window.history, 'replaceState');
    writeSessionHash(ID);
    writeSessionHash(ID);
    expect(replace).not.toHaveBeenCalled();
  });

  it('fires no hashchange', () => {
    const onHash = vi.fn();
    window.addEventListener('hashchange', onHash);
    writeSessionHash(ID);
    writeSessionHash(null);
    window.removeEventListener('hashchange', onHash);
    expect(onHash).not.toHaveBeenCalled();
  });
});

describe('toastForOpenResult', () => {
  const t = (k: string) => `t:${k}`;

  it.each(['opened', 'focused', 'aborted'] as const)('%s → no toast', (r) => {
    expect(toastForOpenResult(r, { t })).toBeNull();
  });

  it.each([
    ['tab_cap', 'warning', 't:ai:aiConversationMove.closeTabToOpen'],
    ['not_found', 'error', 't:ai:aiConversationMove.notAvailable'],
    ['error', 'error', 't:ai:aiConversationMove.notAvailable'],
    ['closed', 'warning', 't:ai:aiConversationMove.wasClosed'],
  ] as const)('%s → %s toast', (r, type, message) => {
    expect(toastForOpenResult(r, { t })).toEqual({ type, message });
  });

  it('topology → a toast whose action opens the conversation in the side panel', () => {
    const onOpenInPanel = vi.fn();
    const toast = toastForOpenResult('topology', { t, onOpenInPanel });
    expect(toast).toMatchObject({ type: 'warning', message: 't:ai:aiConversationMove.topologyFromMap' });
    expect(toast?.action?.label).toBe('t:ai:aiConversationMove.openInPanel');
    toast?.action?.onClick();
    expect(onOpenInPanel).toHaveBeenCalledTimes(1);
  });
});
