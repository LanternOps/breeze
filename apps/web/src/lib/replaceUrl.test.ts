import { describe, it, expect, beforeEach } from 'vitest';
import { replaceUrl, seedRouterHistoryState } from './replaceUrl';

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
