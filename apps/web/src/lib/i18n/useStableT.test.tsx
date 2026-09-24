import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranslation } from 'react-i18next';
import { applyLocale, i18n } from './index';
import { useStableT } from './useStableT';

// #3632: react-i18next returns a NEW `t` on `languageChanged`. `useStableT`
// must keep one identity across that change while still translating with the
// current language.
describe('useStableT', () => {
  afterEach(async () => {
    await act(() => i18n.changeLanguage('en'));
  });

  it('keeps one identity across a locale change and translates with the latest t', async () => {
    await act(() => i18n.changeLanguage('en'));
    const { result } = renderHook(() => {
      const { t } = useTranslation('settings');
      return { t, stableT: useStableT(t) };
    });

    const firstT = result.current.t;
    const firstStable = result.current.stableT;
    expect(firstStable('orgEventLogSettings.save')).toBe('Save settings');

    await act(async () => {
      await applyLocale('fr-FR');
    });

    // Precondition: the raw `t` really did change identity, otherwise this
    // test proves nothing about the hook.
    expect(result.current.t).not.toBe(firstT);
    expect(result.current.stableT).toBe(firstStable);
    // The ORIGINAL stable reference, as captured by an effect closure, now
    // yields the new language.
    expect(firstStable('orgEventLogSettings.save')).toBe(
      result.current.t('orgEventLogSettings.save'),
    );
    expect(firstStable('orgEventLogSettings.save')).not.toBe('Save settings');
  });

  it('forwards every argument to the latest t', () => {
    const calls: unknown[][] = [];
    const tA = (...args: unknown[]) => {
      calls.push(['A', ...args]);
      return 'a';
    };
    const tB = (...args: unknown[]) => {
      calls.push(['B', ...args]);
      return 'b';
    };
    const { result, rerender } = renderHook(({ t }) => useStableT(t), {
      initialProps: { t: tA },
    });
    const stable = result.current;

    expect(stable('key', { count: 2 })).toBe('a');
    rerender({ t: tB });
    expect(result.current).toBe(stable);
    expect(stable('key', { count: 3 })).toBe('b');
    expect(calls).toEqual([
      ['A', 'key', { count: 2 }],
      ['B', 'key', { count: 3 }],
    ]);
  });
});

// Codex review: the ref must only move on COMMIT. A render React discards (here,
// one that throws into an error boundary) must not leak its translator into the
// stable function the committed UI already handed to its effects.
describe('useStableT commit-phase update', () => {
  it('ignores the translator from a render that never commits', async () => {
    const React = await import('react');
    const { render } = await import('@testing-library/react');
    let captured: ((k: string) => string) | undefined;
    function Child({ t, boom }: { t: (k: string) => string; boom: boolean }) {
      const stable = useStableT(t);
      captured ??= stable;
      if (boom) throw new Error('discarded render');
      return null;
    }
    class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
      state = { failed: false };
      static getDerivedStateFromError() { return { failed: true }; }
      render() { return this.state.failed ? null : this.props.children; }
    }
    const committed = (k: string) => `committed:${k}`;
    const discarded = (k: string) => `discarded:${k}`;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(<Boundary><Child t={committed} boom={false} /></Boundary>);
    expect(captured!('x')).toBe('committed:x');
    rerender(<Boundary><Child t={discarded} boom /></Boundary>);
    expect(captured!('x')).toBe('committed:x');
    errorSpy.mockRestore();
  });
});
