import '@/lib/i18n';

import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverflowTabs, overflowTabId, overflowPanelId, type OverflowTab } from './OverflowTabs';

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
  // `clientWidth` lives on Element.prototype, so there is no HTMLElement-level
  // descriptor to put back — delete the stub or it leaks into later suites.
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  else delete (HTMLElement.prototype as any).offsetWidth;
  if (originalClientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
  else delete (HTMLElement.prototype as any).clientWidth;
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

  describe('overflowPanelId', () => {
    it('matches the data-testid/tab-id scheme with a "-panel" suffix when a prefix is given', () => {
      expect(overflowPanelId('overview', 'network-detail-tab-')).toBe('network-detail-tab-overview-panel');
    });

    it('falls back to "tab-<id>-panel" with no prefix', () => {
      expect(overflowPanelId('overview')).toBe('tab-overview-panel');
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

    // #reviewFix10a: with the active tab collapsed into "More", none of the
    // visible tabs used to get tabIndex 0 — a keyboard user tabbing to the
    // tablist landed nowhere reachable at all.
    it('keeps the first visible tab at tabIndex 0 when the active tab is in the "More" overflow', () => {
      render(<OverflowTabs tabs={tabs} activeTab="c" onTabChange={() => {}} testIdPrefix="t-" />);

      // Only 'a' fits as a visible tab under jsdom's zero-width layout.
      const visibleTab = screen.getByTestId('t-a');
      expect(visibleTab.tabIndex).toBe(0);
      expect(visibleTab.getAttribute('aria-selected')).toBe('false');
    });

    // #reviewFix10b
    it('gives each visible tab aria-controls pointing at its panel id', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);

      expect(screen.getByTestId('t-a').getAttribute('aria-controls')).toBe(overflowPanelId('a', 't-'));
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

  describe('secondary tabs, counts and groups', () => {
    beforeEach(() => {
      stubWideLayout();
    });
    afterEach(() => {
      restoreLayout();
    });

    const mixed: OverflowTab[] = [
      { id: 'a', label: 'Alpha', icon: <span /> },
      { id: 'b', label: 'Beta', icon: <span />, count: 3 },
      { id: 'c', label: 'Gamma', icon: <span />, secondary: true, group: 'Signals', count: 2 },
      { id: 'd', label: 'Delta', icon: <span />, secondary: true, group: 'Signals' },
      { id: 'e', label: 'Epsilon', icon: <span />, secondary: true, group: 'Inventory' },
    ];

    it('keeps secondary tabs inside "More" even when the row has room for everything', () => {
      render(<OverflowTabs tabs={mixed} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);
      expect(screen.getAllByRole('tab').map(t => t.id)).toEqual(['t-a', 't-b']);
      expect(screen.queryByTestId('t-c')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: /more/i }));
      expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Gamma2', 'Delta', 'Epsilon']);
    });

    it('renders group headers between groups inside "More"', () => {
      render(<OverflowTabs tabs={mixed} activeTab="a" onTabChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /more/i }));
      const menu = screen.getByRole('menu');
      const headers = Array.from(menu.querySelectorAll('[data-overflow-group]')).map(h => h.textContent);
      expect(headers).toEqual(['Signals', 'Inventory']);
    });

    it('shows a count badge on a visible tab, in the attention token, and a dot (not a sum) on the "More" trigger', () => {
      render(<OverflowTabs tabs={mixed} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);
      const badge = screen.getByTestId('t-b-count');
      expect(badge).toHaveTextContent('3');
      expect(badge.className).toContain('text-warning-strong');
      expect(badge.className).not.toContain('text-primary');
      const more = screen.getByRole('button', { name: /more/i });
      expect(more).not.toHaveTextContent('2');
      expect(screen.getByTestId('t-overflow-tabs-hidden-dot')).toBeInTheDocument();
    });

    it('keeps the dot on the trigger while the active tab lives inside "More"', () => {
      render(<OverflowTabs tabs={mixed} activeTab="e" onTabChange={() => {}} testIdPrefix="t-" />);
      expect(screen.getByTestId('t-overflow-tabs-hidden-dot')).toBeInTheDocument();
    });

    it('renders no dot when nothing hidden needs attention', () => {
      const quiet = mixed.map(t => ({ ...t, count: undefined }));
      render(<OverflowTabs tabs={quiet} activeTab="a" onTabChange={() => {}} testIdPrefix="t-" />);
      expect(screen.queryByTestId('t-overflow-tabs-hidden-dot')).toBeNull();
    });

    it('omits a zero count badge', () => {
      render(<OverflowTabs tabs={[{ id: 'z', label: 'Zed', icon: <span />, count: 0 }]} activeTab="z" onTabChange={() => {}} testIdPrefix="t-" />);
      expect(screen.getByTestId('t-z')).toHaveTextContent(/^Zed$/);
    });

    it('selects a secondary tab from the menu and reflects it on the trigger', () => {
      const onTabChange = vi.fn();
      render(<OverflowTabs tabs={mixed} activeTab="a" onTabChange={onTabChange} />);
      fireEvent.click(screen.getByRole('button', { name: /more/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: /epsilon/i }));
      expect(onTabChange).toHaveBeenCalledWith('e');
    });
  });

  describe('group-first overflow ordering', () => {
    // Default jsdom zero-width layout: only the first primary stays visible,
    // every other primary spills. Spilled primaries must slot into their own
    // group inside "More" rather than being prepended as a run of their own.
    it('interleaves spilled primaries into their groups so no header repeats', () => {
      const tabs: OverflowTab[] = [
        { id: 'a', label: 'Alpha', icon: <span />, group: 'Monitoring' },
        { id: 'b', label: 'Beta', icon: <span />, group: 'Inventory' },
        { id: 'c', label: 'Gamma', icon: <span />, secondary: true, group: 'Monitoring' },
        { id: 'd', label: 'Delta', icon: <span />, secondary: true, group: 'Inventory' },
      ];
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} />);
      expect(screen.getAllByRole('tab').map(t => t.textContent)).toEqual(['Alpha']);
      fireEvent.click(screen.getByRole('button', { name: /more/i }));
      const menu = screen.getByRole('menu');
      const headers = Array.from(menu.querySelectorAll('[data-overflow-group]')).map(h => h.textContent);
      expect(headers).toEqual(['Monitoring', 'Inventory']);
      expect(screen.getAllByRole('menuitem').map(m => m.textContent)).toEqual(['Gamma', 'Beta', 'Delta']);
    });
  });

  describe('"More" menu keyboard behaviour', () => {
    beforeEach(() => {
      stubWideLayout();
    });
    afterEach(() => {
      restoreLayout();
    });
    const tabs: OverflowTab[] = [
      { id: 'a', label: 'Alpha', icon: <span /> },
      { id: 'c', label: 'Gamma', icon: <span />, secondary: true },
      { id: 'd', label: 'Delta', icon: <span />, secondary: true },
      { id: 'e', label: 'Epsilon', icon: <span />, secondary: true },
    ];

    it('moves focus into the menu on open, arrows through items with wrap, Home/End jump', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} />);
      const more = screen.getByRole('button', { name: /more/i });
      fireEvent.click(more);
      const items = screen.getAllByRole('menuitem');
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[1]);
      fireEvent.keyDown(items[1], { key: 'End' });
      expect(document.activeElement).toBe(items[2]);
      fireEvent.keyDown(items[2], { key: 'ArrowDown' });
      expect(document.activeElement).toBe(items[0]);
      fireEvent.keyDown(items[0], { key: 'ArrowUp' });
      expect(document.activeElement).toBe(items[2]);
      fireEvent.keyDown(items[2], { key: 'Home' });
      expect(document.activeElement).toBe(items[0]);
    });

    it('focuses the active item when the active tab is inside the menu', () => {
      render(<OverflowTabs tabs={tabs} activeTab="d" onTabChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /delta/i }));
      expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: /delta/i }));
    });

    it('Escape closes the menu and returns focus to the trigger', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} />);
      const more = screen.getByRole('button', { name: /more/i });
      fireEvent.click(more);
      fireEvent.keyDown(screen.getAllByRole('menuitem')[0], { key: 'Escape' });
      expect(screen.queryByRole('menu')).toBeNull();
      expect(document.activeElement).toBe(more);
    });

    it('constrains the menu height to the space below the trigger, not the viewport', () => {
      render(<OverflowTabs tabs={tabs} activeTab="a" onTabChange={() => {}} />);
      fireEvent.click(screen.getByRole('button', { name: /more/i }));
      const menu = screen.getByRole('menu') as HTMLElement;
      // jsdom: trigger rect bottom is 0, innerHeight 768 → 768 - 0 - 16
      expect(menu.style.maxHeight).toBe('752px');
    });
  });
});
