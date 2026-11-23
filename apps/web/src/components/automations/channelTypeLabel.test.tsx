// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useChannelTypeLabel } from './channelTypeLabel';

describe('useChannelTypeLabel (#12497)', () => {
  it('names a known channel type instead of showing the raw value', () => {
    const { result } = renderHook(() => useChannelTypeLabel());
    expect(result.current('email')).toBe('Email');
    expect(result.current('slack')).toBe('Slack');
    expect(result.current('sms')).toBe('SMS');
  });

  it('falls back to the raw type for one it does not know', () => {
    const { result } = renderHook(() => useChannelTypeLabel());
    expect(result.current('carrier_pigeon')).toBe('carrier_pigeon');
  });
});
