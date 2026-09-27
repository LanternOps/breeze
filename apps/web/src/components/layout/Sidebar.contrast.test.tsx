import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Harness copied from Sidebar.module.test.tsx / Sidebar.nav.test.tsx — stub the
// stores so importing Sidebar.tsx doesn't pull in real auth/ui/org side effects.
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (state: { user: { isPlatformAdmin: boolean; permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false, permissions: [{ resource: '*', action: '*' }] } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: vi.fn(() => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() })),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Sidebar section headings — colour contrast (#7157)', () => {
  it('does not dim the collapsible section heading text below AA contrast', async () => {
    render(<Sidebar currentPath="/" />);

    const heading = await waitFor(() => screen.getByText('Fleet Management'));
    const button = heading.closest('button');
    expect(button).not.toBeNull();

    // `text-muted-foreground/70` renders muted-foreground at 70% opacity over
    // the sidebar's `bg-card` surface, which measures under 4.5:1 in both
    // themes — the axe `color-contrast` failure from the UI audit (#7157).
    // The fix uses the full-opacity token instead.
    expect(button?.className).not.toMatch(/text-muted-foreground\/70/);
    expect(button?.className).toMatch(/\btext-muted-foreground\b/);
  });
});
