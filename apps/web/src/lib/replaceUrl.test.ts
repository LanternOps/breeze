import { describe, it, expect, beforeEach, vi } from 'vitest';
import { replaceUrl, seedRouterHistoryState, URL_CHANGE_EVENT } from './replaceUrl';

describe('replaceUrl', () => {
  beforeEach(() => {
    window.history.replaceState({ index: 3, scrollX: 1, scrollY: 2 }, '', '/devices');
  });

  it("keeps the router's history.state while rewriting the URL", () => {
    replaceUrl('/devices#tab=a');
    expect(window.location.hash).toBe('#tab=a');
    expect(window.history.state).toEqual({ index: 3, scrollX: 1, scrollY: 2 });
  });

  it('does not push a history entry', () => {
    const before = window.history.length;
    replaceUrl('/devices?x=1');
    expect(window.history.length).toBe(before);
  });
});

describe('replaceUrl url-change notification', () => {
  beforeEach(() => {
    window.history.replaceState({ index: 1, scrollX: 0, scrollY: 0 }, '', '/tickets');
  });

  it('dispatches breeze:urlchange after the URL is rewritten', () => {
    expect(URL_CHANGE_EVENT).toBe('breeze:urlchange');
    let hashSeen: string | null = null;
    const listener = () => { hashSeen = window.location.hash; };
    window.addEventListener('breeze:urlchange', listener);
    try {
      replaceUrl('/tickets#type=problem');
    } finally {
      window.removeEventListener('breeze:urlchange', listener);
    }
    // The listener ran after the rewrite, so it saw the new hash.
    expect(hashSeen).toBe('#type=problem');
  });

  it('does not fire hashchange or popstate (event is the only signal)', () => {
    const noisy = vi.fn();
    window.addEventListener('hashchange', noisy);
    window.addEventListener('popstate', noisy);
    try {
      replaceUrl('/tickets#type=change');
    } finally {
      window.removeEventListener('hashchange', noisy);
      window.removeEventListener('popstate', noisy);
    }
    expect(noisy).not.toHaveBeenCalled();
  });
});

describe('seedRouterHistoryState', () => {
  it('seeds the router shape when history.state is null', () => {
    window.history.replaceState(null, '', '/devices#foo');
    seedRouterHistoryState();
    expect(window.history.state).toMatchObject({
      index: expect.any(Number),
      scrollX: expect.any(Number),
      scrollY: expect.any(Number),
    });
    expect(window.location.hash).toBe('#foo');
  });

  it('leaves existing state untouched', () => {
    window.history.replaceState({ index: 7, scrollX: 0, scrollY: 9 }, '', '/devices');
    seedRouterHistoryState();
    expect(window.history.state).toEqual({ index: 7, scrollX: 0, scrollY: 9 });
  });
});
