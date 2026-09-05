import { afterEach, describe, expect, it } from 'vitest';
import { acquireScrollLock, scrollLockHolders } from './scrollLock';

describe('acquireScrollLock', () => {
  afterEach(() => {
    document.body.style.overflow = '';
  });

  it('keeps the body locked until the last holder releases', () => {
    const releaseDrawer = acquireScrollLock();
    const releaseDialog = acquireScrollLock();
    expect(document.body.style.overflow).toBe('hidden');
    expect(scrollLockHolders()).toBe(2);

    releaseDialog();
    expect(document.body.style.overflow).toBe('hidden');

    releaseDrawer();
    expect(document.body.style.overflow).toBe('');
    expect(scrollLockHolders()).toBe(0);
  });

  it('ignores a double release', () => {
    const release = acquireScrollLock();
    release();
    release();
    expect(scrollLockHolders()).toBe(0);
    expect(document.body.style.overflow).toBe('');
  });
});
