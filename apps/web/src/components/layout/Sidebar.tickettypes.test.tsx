import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #7900 W3: Service Desk nav entries per ticket type. The typed entries share
// the `/tickets` pathname, so active state must follow the parsed hash type
// (not the href string) and track in-place hash rewrites.
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
const permissionsState = vi.hoisted(() => ({
  permissions: [{ resource: '*', action: '*' }] as Array<{ resource: string; action: string }>,
}));
vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: fetchWithAuthMock,
  useAuthStore: Object.assign(
    (selector: (state: { user: { isPlatformAdmin: boolean; permissions: Array<{ resource: string; action: string }> } }) => unknown) =>
      selector({ user: { isPlatformAdmin: false, permissions: permissionsState.permissions } }),
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

import Sidebar, { navSections } from './Sidebar';
import { replaceUrl } from '../../lib/replaceUrl';

const ENTRIES = [
  { id: 'nav-tickets-all', href: '/tickets' },
  { id: 'nav-tickets-incident', href: '/tickets#type=incident' },
  { id: 'nav-tickets-service_request', href: '/tickets#type=service_request' },
  { id: 'nav-tickets-problem', href: '/tickets#type=problem' },
  { id: 'nav-tickets-change', href: '/tickets#type=change' },
] as const;

function activeIds(): string[] {
  return ENTRIES.filter((e) => screen.getByTestId(e.id).getAttribute('aria-current') === 'page').map((e) => e.id);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  permissionsState.permissions = [{ resource: '*', action: '*' }];
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/tickets');
});

afterEach(() => {
  window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/');
  vi.clearAllMocks();
});

describe('Service Desk nav structure', () => {
  it('lists Tickets, Incidents, Service Requests, Problems, Changes, Timesheets in order', () => {
    const items = navSections.find((s) => s.id === 'service-desk')!.items;
    expect(items.map((i) => i.href)).toEqual([
      '/tickets',
      '/tickets#type=incident',
      '/tickets#type=service_request',
      '/tickets#type=problem',
      '/tickets#type=change',
      '/timesheet',
    ]);
    expect(items.map((i) => i.labelKey)).toEqual([
      'nav.tickets',
      'nav.ticketsIncidents',
      'nav.ticketsServiceRequests',
      'nav.ticketsProblems',
      'nav.ticketsChanges',
      'nav.timesheets',
    ]);
  });

  it('applies the tickets:read permission to every ticket entry', () => {
    const items = navSections.find((s) => s.id === 'service-desk')!.items.filter((i) => i.href.startsWith('/tickets'));
    expect(items).toHaveLength(5);
    for (const item of items) expect(item.requiredPermission).toEqual({ resource: 'tickets', action: 'read' });
  });

  it('keeps the section behind the service_management module gate', () => {
    expect(navSections.find((s) => s.id === 'service-desk')!.requiresModule).toBe('service_management');
  });
});

describe('Service Desk nav active state', () => {
  it('highlights plain Tickets (only) when the hash has no type', () => {
    render(<Sidebar currentPath="/tickets" />);
    expect(activeIds()).toEqual(['nav-tickets-all']);
  });

  it('reads window.location.hash on mount for deep links', () => {
    window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/tickets#type=problem');
    render(<Sidebar currentPath="/tickets" />);
    expect(activeIds()).toEqual(['nav-tickets-problem']);
  });

  it('matches the parsed type, not the href string (selection + sort in the hash)', () => {
    window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/tickets#T-2026-0001&sort=newest&type=change');
    render(<Sidebar currentPath="/tickets" />);
    expect(activeIds()).toEqual(['nav-tickets-change']);
  });

  it('treats a selection-only hash and an invalid type as plain Tickets', () => {
    window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/tickets#T-2026-0001&type=banana');
    render(<Sidebar currentPath="/tickets" />);
    expect(activeIds()).toEqual(['nav-tickets-all']);
  });

  it('follows replaceUrl rewrites (breeze:urlchange) without remount', () => {
    render(<Sidebar currentPath="/tickets" />);
    expect(activeIds()).toEqual(['nav-tickets-all']);

    act(() => replaceUrl('/tickets#T-2026-0001&type=service_request'));
    expect(activeIds()).toEqual(['nav-tickets-service_request']);

    act(() => replaceUrl('/tickets#T-2026-0001'));
    expect(activeIds()).toEqual(['nav-tickets-all']);
  });

  it('follows hashchange and popstate', () => {
    render(<Sidebar currentPath="/tickets" />);
    act(() => {
      window.location.hash = '#type=incident';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(activeIds()).toEqual(['nav-tickets-incident']);

    act(() => {
      window.history.replaceState(window.history.state, '', '/tickets#type=change');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(activeIds()).toEqual(['nav-tickets-change']);
  });

  it('follows astro:after-swap', () => {
    render(<Sidebar currentPath="/tickets" />);
    act(() => {
      window.history.replaceState(window.history.state, '', '/tickets#type=problem');
      document.dispatchEvent(new Event('astro:after-swap'));
    });
    expect(activeIds()).toEqual(['nav-tickets-problem']);
  });

  it('highlights plain Tickets on a ticket detail page, never a typed entry', () => {
    window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/tickets/abc-123#type=problem');
    render(<Sidebar currentPath="/tickets/abc-123" />);
    expect(activeIds()).toEqual(['nav-tickets-all']);
  });

  it('does not highlight any ticket entry off the tickets page', () => {
    window.history.replaceState({ index: 0, scrollX: 0, scrollY: 0 }, '', '/timesheet#type=problem');
    render(<Sidebar currentPath="/timesheet" />);
    expect(activeIds()).toEqual([]);
  });
});

describe('Service Desk nav gates', () => {
  it('hides every ticket entry without tickets:read but keeps rendering the rest', () => {
    permissionsState.permissions = [{ resource: 'time_entries', action: 'read' }];
    render(<Sidebar currentPath="/timesheet" />);
    for (const e of ENTRIES) expect(screen.queryByTestId(e.id)).toBeNull();
  });
});
