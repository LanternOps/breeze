/**
 * Tool catalog W01 PR C (#5216) — the Tool Sources nav entry is gated on the
 * SERVER flag, not on a client constant: `TOOL_SOURCES_ENABLED` off makes
 * every `/tool-sources` route answer 404, so showing the item would be a link
 * to a dead page. Default CLOSED (an unreachable or older `/config` hides it)
 * — same posture as `features.aiOperatorTasks`, for the same reason: this
 * surface authors credentials that reach customer systems.
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
// The item also carries `tool_sources:read`, so the fixture user holds it —
// the RBAC gate is exercised in Sidebar.rbac.test.tsx; this suite isolates the
// SERVER flag.
const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [{ resource: 'tool_sources', action: 'read' }] },
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (s: { user: typeof state.user }) => unknown) => selector({ user: state.user }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: () => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() }),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar from './Sidebar';
import { useFeaturesStore } from '../../stores/featuresStore';

function mockConfig(body: unknown, ok = true) {
  fetchWithAuthMock.mockImplementation((url: string) => {
    if (url === '/config') {
      return Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => body } as Response);
    }
    if (url === '/orgs/partners/me') {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ name: 'Acme MSP', settings: {} }),
      } as Response);
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as Response);
  });
}

beforeEach(() => {
  fetchWithAuthMock.mockReset();
  // The store is a module singleton with a `loaded` short-circuit, so a
  // previous test's answer would otherwise decide this one's.
  useFeaturesStore.setState({
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false },
    loaded: false,
  });
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(),
    dispatchEvent: vi.fn(), onchange: null,
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => vi.clearAllMocks());

describe('Sidebar — Tool Sources server gate', () => {
  it('shows the nav item when /config reports features.toolSources true', async () => {
    mockConfig({ features: { toolSources: true } });
    const { container } = render(<Sidebar currentPath="/settings/tool-sources" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/settings/tool-sources"]')).not.toBeNull(),
    );
  });

  it('hides the nav item when the flag is false', async () => {
    mockConfig({ features: { toolSources: false } });
    const { container } = render(<Sidebar currentPath="/settings/tool-sources" />);
    // Wait for the sidebar to be rendered at all before asserting an absence.
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/settings/tool-sources"]')).toBeNull();
  });

  it('hides the nav item from a user without tool_sources:read even when the flag is on', async () => {
    mockConfig({ features: { toolSources: true } });
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    try {
      const { container } = render(<Sidebar currentPath="/settings/tool-sources" />);
      await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
      expect(container.querySelector('a[href="/settings/tool-sources"]')).toBeNull();
    } finally {
      state.user.permissions = [{ resource: 'tool_sources', action: 'read' }];
    }
  });

  it('hides the nav item when /config is unreachable (fails closed)', async () => {
    mockConfig({}, false);
    const { container } = render(<Sidebar currentPath="/settings/tool-sources" />);
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/settings/tool-sources"]')).toBeNull();
  });
});
