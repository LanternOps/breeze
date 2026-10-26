import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ wide: false, panelOpen: false }));
vi.mock('@/lib/useMediaQuery', () => ({ useMediaQuery: () => h.wide }));
vi.mock('@/stores/aiStore', () => ({
  useAiStore: (sel: (s: { isOpen: boolean }) => unknown) => sel({ isOpen: h.panelOpen }),
}));
vi.mock('./WispRailStrip', () => ({
  default: (p: { needsYouCount: number; rail: React.ReactNode }) => (
    <div data-testid="strip-stub" data-count={p.needsYouCount}>{p.rail}</div>
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
  beforeEach(() => { h.wide = false; h.panelOpen = false; });
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

  it('keeps the rail clear of the docked panel while it is open', () => {
    h.wide = true;
    h.panelOpen = true;
    renderShell();
    expect(screen.getByTestId('wisp-home').className).toContain('lg:pr-[400px]');
  });
});
