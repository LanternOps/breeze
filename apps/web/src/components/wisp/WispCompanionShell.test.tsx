import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  wide: false,
  panelOpen: false,
  /** The page's composer claims the store's thread (`wispPageThreadId`, th-1 = this thread). */
  pageThreadId: null as string | null,
  showHistory: false,
}));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => h.wide }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ isOpen: h.panelOpen, wisp: { threadId: 'th-1' }, wispPageThreadId: h.pageThreadId, showHistory: h.showHistory }),
}));
vi.mock('./WispRailStrip', () => ({
  default: (p: { needsYouCount: number; rail: React.ReactNode; visibleWhenWide?: boolean }) => (
    <div data-testid="strip-stub" data-count={p.needsYouCount} data-visible-when-wide={String(!!p.visibleWhenWide)}>{p.rail}</div>
  ),
}));

import WispCompanionShell from './WispCompanionShell';

const wisp = { grantId: 'g-1', threadId: 'th-1', scopeOrgId: null, focusOrgId: null, focusOrgName: null, status: 'active' as const, expiresAt: '2026-12-01T00:00:00Z', summary: '', budgetCentsPerDay: 200, floorTickMinutes: 30, wideningAvailable: false };

const renderShell = () =>
  render(
    <WispCompanionShell
      testId="wisp-home"
      wisp={wisp}
      current={null}
      needsYouCount={3}
      banners={<div data-testid="banner" />}
      column={<section data-testid="column" />}
      rail={<div data-testid="rail" />}
    />,
  );

describe('WispCompanionShell', () => {
  beforeEach(() => { h.wide = false; h.panelOpen = false; h.pageThreadId = null; h.showHistory = false; });
  afterEach(() => vi.clearAllMocks());

  it('wide: the rail sits in the aside and no strip renders', () => {
    h.wide = true;
    renderShell();
    expect(screen.getByTestId('wisp-rail-aside')).toContainElement(screen.getByTestId('rail'));
    expect(screen.queryByTestId('strip-stub')).toBeNull();
    expect(screen.getByTestId('wisp-home')).toContainElement(screen.getByTestId('column'));
  });

  it('narrow: the strip carries the rail and the needs-you count; no aside, so the rail mounts once', () => {
    renderShell();
    expect(screen.queryByTestId('wisp-rail-aside')).toBeNull();
    expect(screen.getByTestId('strip-stub')).toHaveAttribute('data-count', '3');
    expect(screen.getAllByTestId('rail')).toHaveLength(1);
  });

  it('banners render above the column', () => {
    renderShell();
    const banner = screen.getByTestId('banner');
    expect(banner.compareDocumentPosition(screen.getByTestId('column')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the content clear of the docked panel while it is open, and only then', () => {
    h.wide = true;
    h.panelOpen = true;
    const { unmount } = renderShell();
    expect(screen.getByTestId('wisp-home').className).toContain('lg:pr-[400px]');
    unmount();
    h.panelOpen = false;
    renderShell();
    expect(screen.getByTestId('wisp-home').className).not.toContain('lg:pr-[400px]');
  });

  // The open pane already carries the grant, spend and pause controls: a third
  // column would repeat the identity card and crush the conversation.
  it('wide with the pane open: the strip stands in for the rail (shown at lg too) and no aside renders', () => {
    h.wide = true;
    h.panelOpen = true;
    renderShell();
    expect(screen.queryByTestId('wisp-rail-aside')).toBeNull();
    expect(screen.getByTestId('strip-stub')).toHaveAttribute('data-visible-when-wide', 'true');
    expect(screen.getAllByTestId('rail')).toHaveLength(1);
  });

  // Handed off, the pane shows one line and the page's composer is the
  // conversation: collapsing the rail there would leave no grant controls on screen.
  it('wide with the pane open but handed off to the page composer: the aside stays and the content is not padded', () => {
    h.wide = true;
    h.panelOpen = true;
    h.pageThreadId = 'th-1';
    renderShell();
    expect(screen.getByTestId('wisp-rail-aside')).toContainElement(screen.getByTestId('rail'));
    expect(screen.queryByTestId('strip-stub')).toBeNull();
    expect(screen.getByTestId('wisp-home').className).not.toContain('lg:pr-[400px]');
  });

  it('a pane showing History beside the page is a real pane: the strip stands in and the content keeps clear', () => {
    h.wide = true;
    h.panelOpen = true;
    h.pageThreadId = 'th-1';
    h.showHistory = true;
    renderShell();
    expect(screen.queryByTestId('wisp-rail-aside')).toBeNull();
    expect(screen.getByTestId('strip-stub')).toBeInTheDocument();
    expect(screen.getByTestId('wisp-home').className).toContain('lg:pr-[400px]');
  });

  it('narrow: the strip keeps its lg:hidden fallback (visibleWhenWide off)', () => {
    renderShell();
    expect(screen.getByTestId('strip-stub')).toHaveAttribute('data-visible-when-wide', 'false');
  });
});
