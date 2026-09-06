import '@/lib/i18n';

import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverflowTabs, overflowTabId, type OverflowTab } from './OverflowTabs';

const tabs: OverflowTab[] = [
  { id: 'a', label: 'Alpha', icon: <span data-testid="icon-a" /> },
  { id: 'b', label: 'Beta', icon: <span data-testid="icon-b" /> },
  { id: 'c', label: 'Gamma', icon: <span data-testid="icon-c" /> },
  { id: 'd', label: 'Delta', icon: <span data-testid="icon-d" /> },
];

// jsdom always reports 0 for offsetWidth/clientWidth, which the component's
// own measurement collapses to "only the first tab fits" (see
// NetworkDeviceDetailPage.test.tsx's identical comment). The roving-focus
// tests need every tab visible at once, so these two suites stub a roomy
// layout for the duration of the describe block that needs it, and restore
// jsdom's own descriptors afterward so it can't leak into later tests.
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');

function stubWideLayout() {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    value: 60,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 2000,
  });
}

function restoreLayout() {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
}

describe('OverflowTabs', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('overflowTabId', () => {
    it('matches the data-testid scheme (prefix + id, no separator) when a prefix is given', () => {
      expect(overflowTabId('overview', 'network-detail-tab-')).toBe('network-detail-tab-overview');
    });

    it('falls back to "tab-<id>" with no prefix', () => {
      expect(overflowTabId('overview')).toBe('tab-overview');
    });
  });

  // Default (unstubbed) jsdom layout: everything past the first tab collapses
  // into the "More" menu — exercised deliberately here, not worked around.
  describe('with the default jsdom (zero-width) layout — collapsed into "More"', () => {
    it('gives the nav role="tablist" and the visible tab role="tab" with aria-selected/tabIndex', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);

      expect(screen.getByRole('tablist')).toBeTruthy();
      const tab = screen.getByTestId('t-a');
      expect(tab.getAttribute('role')).toBe('tab');
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(tab.tabIndex).toBe(0);
      expect(tab.id).toBe('t-a');
    });

    it('gives the More trigger aria-haspopup/aria-expanded, and overflow items role="menuitem"', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);

      const more = screen.getByText('More');
      expect(more.getAttribute('aria-haspopup')).toBe('menu');
      expect(more.getAttribute('aria-expanded')).toBe('false');

      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');

      const beta = screen.getByTestId('t-b');
      expect(beta.getAttribute('role')).toBe('menuitem');
      // Overflow items are not part of the roving tablist sequence.
      expect(beta.getAttribute('role')).not.toBe('tab');
    });

    it('activating an overflow item calls onTabChange with its id', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={onTabChange} testIdPrefix="t-" />);

      fireEvent.click(screen.getByText('More'));
      fireEvent.click(screen.getByTestId('t-c'));

      expect(onTabChange).toHaveBeenCalledWith('c');
    });
  });

  describe('with a wide (all-tabs-visible) layout — roving focus', () => {
    beforeEach(() => {
      stubWideLayout();
    });
    afterEach(() => {
      restoreLayout();
    });

    it('gives only the active tab tabIndex 0; the rest get -1', () => {
      render(<OverflowTabs tabs={tabs} activeTab="b" onTabChange={() => {}} testIdPrefix="t-" />);

      expect(screen.getByTestId('t-a').tabIndex).toBe(-1);
      expect(screen.getByTestId('t-b').tabIndex).toBe(0);
      expect(screen.getByTestId('t-b').getAttribute('aria-selected')).toBe('true');
      expect(screen.getByTestId('t-c').tabIndex).toBe(-1);
    });

    it('ArrowRight moves focus to the next tab and selects it, wrapping past the last', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={onTabChange} testIdPrefix="t-" />);

      const first = screen.getByTestId('t-a');
      const second = screen.getByTestId('t-b');
      first.focus();

      fireEvent.keyDown(first, { key: 'ArrowRight' });
      expect(onTabChange).toHaveBeenCalledWith('b');
      expect(document.activeElement).toBe(second);

      // Wrap: ArrowRight from the last tab goes back to the first.
      const last = screen.getByTestId('t-d');
      last.focus();
      fireEvent.keyDown(last, { key: 'ArrowRight' });
      expect(onTabChange).toHaveBeenCalledWith('a');
      expect(document.activeElement).toBe(first);
    });

    it('ArrowLeft moves focus to the previous tab, wrapping past the first', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={tabs} activeTab="b" onTabChange={onTabChange} testIdPrefix="t-" />);

      const second = screen.getByTestId('t-b');
      const first = screen.getByTestId('t-a');
      second.focus();

      fireEvent.keyDown(second, { key: 'ArrowLeft' });
      expect(onTabChange).toHaveBeenCalledWith('a');
      expect(document.activeElement).toBe(first);

      // Wrap: ArrowLeft from the first tab goes to the last.
      first.focus();
      fireEvent.keyDown(first, { key: 'ArrowLeft' });
      expect(onTabChange).toHaveBeenCalledWith('d');
      expect(document.activeElement).toBe(screen.getByTestId('t-d'));
    });

    it('Home moves focus/selection to the first tab; End to the last', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={tabs} activeTab="b" onTabChange={onTabChange} testIdPrefix="t-" />);

      const second = screen.getByTestId('t-b');
      second.focus();

      fireEvent.keyDown(second, { key: 'End' });
      expect(onTabChange).toHaveBeenCalledWith('d');
      expect(document.activeElement).toBe(screen.getByTestId('t-d'));

      fireEvent.keyDown(screen.getByTestId('t-d'), { key: 'Home' });
      expect(onTabChange).toHaveBeenCalledWith('a');
      expect(document.activeElement).toBe(screen.getByTestId('t-a'));
    });

    it('does not react to other keys (e.g. Enter is left to the button default)', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={onTabChange} testIdPrefix="t-" />);

      fireEvent.keyDown(screen.getByTestId('t-a'), { key: 'Enter' });
      expect(onTabChange).not.toHaveBeenCalled();
    });
  });

  it('still calls onTabChange on click, unaffected by the keyboard changes', () => {
    const onTabChange = vi.fn();
    render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={onTabChange} testIdPrefix="t-" />);
    fireEvent.click(screen.getByTestId('t-a'));
    expect(onTabChange).toHaveBeenCalledWith('a');
  });
});
