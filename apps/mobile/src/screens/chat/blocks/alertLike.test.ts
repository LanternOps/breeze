import { describe, expect, it, vi } from 'vitest';

import { toAlert } from './alertLike';

describe('toAlert', () => {
  it('never invents a createdAt/updatedAt when the chat payload lacks one (#8891)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-16T12:00:00.000Z'));
    try {
      const a = toAlert({ id: 'a1', title: 'CPU high' });
      expect(a.createdAt).toBe('');
      expect(a.updatedAt).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the payload timestamps when present', () => {
    const a = toAlert({ id: 'a1', createdAt: '2026-10-16T11:00:00.000Z' });
    expect(a.createdAt).toBe('2026-10-16T11:00:00.000Z');
    expect(a.updatedAt).toBe('2026-10-16T11:00:00.000Z');
  });
});
