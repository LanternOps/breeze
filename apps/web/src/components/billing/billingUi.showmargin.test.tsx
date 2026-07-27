// The billing-wide "show cost & margin" preference must stay coherent across
// every mounted consumer: same-page instances sync via a custom event (the
// browser's `storage` event only fires in OTHER tabs), and other tabs sync via
// `storage`. Removing either channel makes "no margin on screen" a per-widget
// promise — the exact leak the hook exists to prevent.
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { MarginToggle, useShowMargin, SHOW_INTERNAL_MARGIN_KEY, _resetShowMarginMemoryForTests } from './billingUi';

// Two independent hook consumers on one page — e.g. the workspace header
// toggle and a Detail tab's pill.
function Consumer({ id }: { id: string }) {
  const [show, toggle] = useShowMargin();
  return (
    <div>
      <MarginToggle show={show} onToggle={toggle} testId={`toggle-${id}`} />
      <span data-testid={`state-${id}`}>{show ? 'on' : 'off'}</span>
    </div>
  );
}

describe('useShowMargin — cross-instance sync', () => {
  beforeEach(() => {
    localStorage.clear();
    _resetShowMarginMemoryForTests();
  });

  it('flipping one instance updates every other instance on the page', async () => {
    render(<><Consumer id="a" /><Consumer id="b" /></>);
    expect(screen.getByTestId('state-a')).toHaveTextContent('off');
    expect(screen.getByTestId('state-b')).toHaveTextContent('off');

    fireEvent.click(screen.getByTestId('toggle-a'));
    expect(screen.getByTestId('state-a')).toHaveTextContent('on');
    // The sibling hears about it via the deferred sync event.
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('state-b')).toHaveTextContent('on');
    expect(localStorage.getItem(SHOW_INTERNAL_MARGIN_KEY)).toBe('1');

    fireEvent.click(screen.getByTestId('toggle-b'));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('state-a')).toHaveTextContent('off');
    expect(screen.getByTestId('state-b')).toHaveTextContent('off');
  });

  it('a storage event from another tab syncs mounted instances', () => {
    render(<Consumer id="a" />);
    expect(screen.getByTestId('state-a')).toHaveTextContent('off');

    // Another tab persisted "on" — the storage event carries it here.
    localStorage.setItem(SHOW_INTERNAL_MARGIN_KEY, '1');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: SHOW_INTERNAL_MARGIN_KEY, newValue: '1' }));
    });
    expect(screen.getByTestId('state-a')).toHaveTextContent('on');
  });
});
