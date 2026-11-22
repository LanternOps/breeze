/**
 * One "Automations" nav entry (#12437). It links `/flows` only while the SERVER
 * flag is on (`FLOWS_ENABLED` off makes every `/flows` route answer 404), else
 * `/jobs`. Default CLOSED: an unreachable or older `/config` links `/jobs`.
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
    features: { billing: false, support: false, aiOperatorTasks: false, aiAgentsSweepAct: false, aiAgentsPolicyDecide: false, toolSources: false, flows: false, preAssignmentEnrollment: false, callerVerification: false, sendingDomains: false, vendorUpdates: false },
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

describe('Sidebar — one Automations entry (Flows server gate)', () => {
  const hrefsOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
  const automationsLink = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('Automations')) ?? null;

  it('one Automations entry links /flows when Flows is on', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/flows"]')).not.toBeNull());
    expect(automationsLink(container)?.getAttribute('href')).toBe('/flows');
  });

  it('it links /jobs when Flows is off', async () => {
    mockConfig({ features: { flows: false } });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(automationsLink(container)).not.toBeNull());
    expect(automationsLink(container)?.getAttribute('href')).toBe('/jobs');
  });

  it('it links /jobs when /config is unreachable (fails closed)', async () => {
    mockConfig({}, false);
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(automationsLink(container)).not.toBeNull());
    expect(automationsLink(container)?.getAttribute('href')).toBe('/jobs');
    expect(container.querySelector('a[href="/flows"]')).toBeNull();
  });

  it.each([
    ['/jobs', true],
    ['/jobs', false],
    ['/jobs/new', false],
    ['/flows', true],
    ['/flows/runs/abc', true],
    ['/flows/abc/edit', true],
  ])('it is active on %s (Flows on: %s)', async (path, flowsOn) => {
    mockConfig({ features: { flows: flowsOn } });
    const { container } = render(<Sidebar currentPath={path} />);
    await waitFor(() => expect(automationsLink(container)).not.toBeNull());
    await waitFor(() =>
      expect(automationsLink(container)?.getAttribute('href')).toBe(flowsOn ? '/flows' : '/jobs'),
    );
    expect(automationsLink(container)?.getAttribute('aria-current')).toBe('page');
  });

  it.each(['/scripts', '/jobsfoo', '/flowsx'])('is not active on %s', async (path) => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath={path} />);
    await waitFor(() => expect(automationsLink(container)).not.toBeNull());
    expect(automationsLink(container)?.getAttribute('aria-current')).toBeNull();
  });

  it('lights exactly one link on a Flows page', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/flows/runs/abc" />);
    await waitFor(() => expect(automationsLink(container)?.getAttribute('aria-current')).toBe('page'));
    expect(container.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
  });

  it('no Jobs or Flows entry remains', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/flows"]')).not.toBeNull());
    const names = Array.from(container.querySelectorAll('a')).map((a) => a.textContent?.trim());
    expect(names).not.toContain('Jobs');
    expect(names).not.toContain('Flows');
    expect(names).not.toContain('Flows Preview');
    expect(container.querySelector('a[href="/jobs"]')).toBeNull();
    expect(hrefsOf(container).filter((h) => h === '/flows' || h === '/jobs')).toHaveLength(1);
  });

  // Q1 default (option a): the Preview tag moves onto the Flows tab.
  it('carries no Preview tag on the nav entry', async () => {
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/flows"]')).not.toBeNull());
    expect(container.querySelector('[data-testid="nav-preview-tag"]')).toBeNull();
  });

  it('names the entry on the collapsed rail', async () => {
    localStorage.setItem('sidebar-mode', 'collapsed');
    mockConfig({ features: { flows: true } });
    const { container } = render(<Sidebar currentPath="/" />);
    await waitFor(() => expect(container.querySelector('a[href="/flows"]')).not.toBeNull());
    const link = container.querySelector('a[href="/flows"]')!;
    expect(link.getAttribute('title')).toBe('Automations');
    expect(link.textContent).toBe('Automations');
  });

  it('without automations.read there is no entry', async () => {
    mockConfig({ features: { flows: true } });
    state.user.permissions = [{ resource: 'devices', action: 'read' }];
    try {
      const { container } = render(<Sidebar currentPath="/" />);
      await waitFor(() => expect(container.querySelector('a[href="/"]')).not.toBeNull());
      expect(container.querySelector('a[href="/flows"]')).toBeNull();
      expect(container.querySelector('a[href="/jobs"]')).toBeNull();
      expect(automationsLink(container)).toBeNull();
    } finally {
      state.user.permissions = [{ resource: 'automations', action: 'read' }];
    }
  });
});

// Operator Recipe Library W06 R1b (#6171): the /operator entry rides the same
// /config store, on `features.aiOperatorTasks`, plus ai_agents:read.
describe('Sidebar — Operator workspace server gate', () => {
  const withAiRead = (fn: () => Promise<void>) => async () => {
    state.user.permissions = [{ resource: 'ai_agents', action: 'read' }];
    try {
      await fn();
    } finally {
      state.user.permissions = [{ resource: 'automations', action: 'read' }];
    }
  };

  it('shows /operator when /config reports features.aiOperatorTasks true', withAiRead(async () => {
    mockConfig({ features: { aiOperatorTasks: true } });
    const { container } = render(<Sidebar currentPath="/operator" />);
    await waitFor(() => expect(container.querySelector('a[href="/operator"]')).not.toBeNull());
  }));

  it('hides /operator when the flag is false', withAiRead(async () => {
    mockConfig({ features: { aiOperatorTasks: false } });
    const { container } = render(<Sidebar currentPath="/operator" />);
    await waitFor(() => expect(container.querySelector('a[href="/"]')).not.toBeNull());
    expect(container.querySelector('a[href="/operator"]')).toBeNull();
  }));

  it('hides /operator when /config is unreachable (fails closed)', withAiRead(async () => {
    mockConfig({}, false);
    const { container } = render(<Sidebar currentPath="/operator" />);
    await waitFor(() => expect(container.querySelector('a[href="/"]')).not.toBeNull());
    expect(container.querySelector('a[href="/operator"]')).toBeNull();
  }));

  it('hides /operator from a user without ai_agents:read even when the flag is on', async () => {
    mockConfig({ features: { aiOperatorTasks: true } });
    const { container } = render(<Sidebar currentPath="/operator" />);
    await waitFor(() => expect(container.querySelector('a[href="/"]')).not.toBeNull());
    expect(container.querySelector('a[href="/operator"]')).toBeNull();
  });
});
