/**
 * Tool catalog W3 (#5218) — the Flows nav entry is gated on the SERVER flag
 * (`FLOWS_ENABLED` off makes every `/flows` route answer 404) and sits
 * directly after Jobs. Default CLOSED: an unreachable or older `/config`
 * hides it.
 */
import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuthMock = vi.hoisted(() => vi.fn());
// The item also carries `automations:read`, so the fixture user holds it —
// the RBAC gate is exercised in Sidebar.rbac.test.tsx; this suite isolates the
// SERVER flag.
const state = vi.hoisted(() => ({
  user: { isPlatformAdmin: false, permissions: [{ resource: 'automations', action: 'read' }] },
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
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false },
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

describe('Sidebar — Flows server gate', () => {
  it('shows the nav item when /config reports features.flows true', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/flows" />);
    await waitFor(() =>
      expect(container.querySelector('a[href="/flows"]')).not.toBeNull(),
    );
  });

  it('places Flows directly after Jobs', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/flows" />);
    await waitFor(() => expect(container.querySelector('a[href="/flows"]')).not.toBeNull());
    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs.indexOf('/flows')).toBe(hrefs.indexOf('/jobs') + 1);
  });

  it('hides the nav item when the flag is false', async () => {
    mockConfig({ features: { flows: false } });
    const { container } = render(<Sidebar currentPath="/flows" />);
    // Wait for the sidebar to be rendered at all before asserting an absence.
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/flows"]')).toBeNull();
  });

  it('hides the nav item from a user without automations:read even when the flag is on', async () => {
    mockConfig({ features: { flows: true } });
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    try {
      const { container } = render(<Sidebar currentPath="/flows" />);
      await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
      expect(container.querySelector('a[href="/flows"]')).toBeNull();
    } finally {
      state.user.permissions = [{ resource: 'automations', action: 'read' }];
    }
  });

  it('hides the nav item when /config is unreachable (fails closed)', async () => {
    mockConfig({}, false);
    const { container } = render(<Sidebar currentPath="/flows" />);
    await waitFor(() => expect(container.querySelector('a[href="/fleet"]')).not.toBeNull());
    expect(container.querySelector('a[href="/flows"]')).toBeNull();
  });
});
