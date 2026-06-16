import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The "AI for Office" nav item is gated by featureEnabled: ENABLE_AI_FOR_OFFICE
// (Sidebar renderNavItem: `if (item.featureEnabled === false) return null`).
// ENABLE_AI_FOR_OFFICE is read at module load when navSections is built, so each
// test sets the flag then re-imports Sidebar via resetModules to rebuild it.
const flagState = vi.hoisted(() => ({
  ENABLE_AI_FOR_OFFICE: false,
  ENABLE_NETWORK_DEVICES_IN_LIST: false,
  ENABLE_ENDPOINT_AV_FEATURES: false,
}));
vi.mock('../../lib/featureFlags', () => flagState);

// Render-time deps — keep them inert; we only care about nav-item gating.
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(() => Promise.resolve({ ok: false } as Response)),
  useAuthStore: Object.assign(
    (selector: (s: { user: { isPlatformAdmin: boolean } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
// Partner scope so the item's partnerScopeOnly check passes — isolating the flag.
vi.mock('../../lib/authScope', () => ({
  getJwtClaims: () => ({ scope: 'partner' }),
}));
vi.mock('./BrandHeader', () => ({ default: () => null }));

async function renderSidebar(enabled: boolean) {
  flagState.ENABLE_AI_FOR_OFFICE = enabled;
  vi.resetModules();
  const { default: Sidebar } = await import('./Sidebar');
  // currentPath inside the AI & Fleet section auto-expands it so its items render.
  return render(<Sidebar currentPath="/ai-for-office" />);
}

beforeEach(() => {
  flagState.ENABLE_AI_FOR_OFFICE = false;
  localStorage.clear();
  // Force the "open" mode so section items render expanded with their anchors.
  localStorage.setItem('sidebar-mode', 'open');
  // jsdom has no matchMedia; desktop (no match) keeps the sidebar open.
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

describe('Sidebar — AI for Office feature gate', () => {
  it('hides the AI for Office nav item when ENABLE_AI_FOR_OFFICE is off (default)', async () => {
    const { container } = await renderSidebar(false);
    expect(container.querySelector('a[href="/ai-for-office"]')).toBeNull();
  });

  it('shows the AI for Office nav item when ENABLE_AI_FOR_OFFICE is on', async () => {
    const { container } = await renderSidebar(true);
    expect(container.querySelector('a[href="/ai-for-office"]')).not.toBeNull();
  });

  it('does not gate sibling items in the same section (Fleet is always present)', async () => {
    const { container } = await renderSidebar(false);
    expect(container.querySelector('a[href="/fleet"]')).not.toBeNull();
  });
});
