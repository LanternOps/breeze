import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useUnsavedGuard } from './useUnsavedGuard';

const MESSAGE = 'You have unsaved changes. Leave and discard them?';

// Clicks a link the way a user does. The bubble-phase listener stands in for
// Astro's ClientRouter, which skips a click that is already cancelled and
// otherwise takes it over. Returns whether the navigation would go ahead.
function clickLink(href: string, init: MouseEventInit = {}, attrs: Record<string, string> = {}): boolean {
  const link = document.createElement('a');
  link.setAttribute('href', href);
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  document.body.append(link);
  let navigates = false;
  const router = (e: Event) => {
    navigates = !e.defaultPrevented;
    e.preventDefault();
  };
  document.addEventListener('click', router);
  link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
  document.removeEventListener('click', router);
  link.remove();
  return navigates;
}

function isBlocked(type: 'beforeunload' | 'astro:before-preparation'): boolean {
  const e = new Event(type, { cancelable: true });
  (type === 'beforeunload' ? window : document).dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(() => vi.restoreAllMocks());

describe('useUnsavedGuard (#12622)', () => {
  it('Cancel on a link click keeps the user on the page, asked once', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHook(() => useUnsavedGuard(true, MESSAGE));
    expect(clickLink('/devices')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(MESSAGE);
  });

  it('Leave on a link click navigates with no second prompt', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderHook(() => useUnsavedGuard(true, MESSAGE));
    expect(clickLink('/devices')).toBe(true);
    expect(isBlocked('astro:before-preparation')).toBe(false);
    expect(isBlocked('beforeunload')).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('does not ask on a clean page, for an in-page anchor, or for a link that opens elsewhere', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { rerender } = renderHook(({ dirty }) => useUnsavedGuard(dirty, MESSAGE), { initialProps: { dirty: false } });
    expect(clickLink('/devices')).toBe(true);
    rerender({ dirty: true });
    expect(clickLink('#patch')).toBe(true);
    expect(clickLink('#')).toBe(true);
    expect(clickLink('/devices', { ctrlKey: true })).toBe(true);
    expect(clickLink('/devices', {}, { target: '_blank' })).toBe(true);
    expect(clickLink('/export.csv', {}, { download: '' })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('still guards navigations that are not link clicks', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderHook(() => useUnsavedGuard(true, MESSAGE));
    expect(isBlocked('beforeunload')).toBe(true);
    expect(isBlocked('astro:before-preparation')).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
