// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { applyLocale } from '@/lib/i18n';
import { useTrustControlCopy } from './trustControlCopy';

describe('useTrustControlCopy', () => {
  afterEach(async () => { await act(async () => { await applyLocale('en'); }); });

  it('is English by default', () => {
    const { result } = renderHook(() => useTrustControlCopy());
    expect(result.current.controlTitle('disk_encryption')).toBe('Disk encryption');
    expect(result.current.categoryLabel('data_protection')).toBe('Data protection');
    expect(result.current.controlDescription('cyber_insurance')).toMatch(/cyber insurance policy/);
  });

  it('returns the German title for disk_encryption when the UI language is de-DE', async () => {
    await act(async () => { await applyLocale('de-DE'); });
    const { result } = renderHook(() => useTrustControlCopy());
    expect(result.current.controlTitle('disk_encryption')).toBe('Festplattenverschlüsselung');
    expect(result.current.categoryLabel('governance')).not.toBe('Governance and response');
    expect(result.current.controlTitle('cyber_insurance')).not.toBe('Cyber insurance');
  });

  it('follows a language change without remounting', async () => {
    const { result } = renderHook(() => useTrustControlCopy());
    expect(result.current.controlTitle('disk_encryption')).toBe('Disk encryption');
    await act(async () => { await applyLocale('fr-FR'); });
    expect(result.current.controlTitle('disk_encryption')).not.toBe('Disk encryption');
  });
});
