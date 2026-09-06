import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';

// Mock the stores so importing Sidebar.tsx (which the navSections export lives
// in) doesn't pull in real auth/ui store side effects.
import { vi } from 'vitest';
const fetchWithAuthMock = vi.hoisted(() => vi.fn());
vi.mock('../../stores/auth', () => ({
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
// This suite is about the STATIC core `navSections` structure — the runtime
// "Extensions" section has its own dedicated coverage in
// Sidebar.extensions.test.tsx. Stub it out here so the module doesn't need a
// real (subscribable) auth store or registry fetch.
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => [],
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: 'partner' }) }));
vi.mock('./BrandHeader', () => ({ default: () => null }));

import Sidebar, { navSections, topLevelNav } from './Sidebar';
import { i18n, loadLocale } from '../../lib/i18n';
import en from '../../locales/en/common.json';
import ptBR from '../../locales/pt-BR/common.json';

beforeEach(async () => {
  localStorage.clear();
  localStorage.setItem('sidebar-mode', 'open');
  fetchWithAuthMock.mockReset();
  fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as Response);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  await i18n.changeLanguage('en');
  await loadLocale('pt-BR');
});

afterEach(async () => {
  await i18n.changeLanguage('en');
  vi.clearAllMocks();
});

function section(id: string) {
  const s = navSections.find((sec) => sec.id === id);
  if (!s) throw new Error(`section "${id}" not found`);
  return s;
}

function hrefsOf(id: string) {
  return section(id).items.map((i) => i.href);
}

describe('navSections structure (#1321, #1324)', () => {
  it('includes a Billing entry in the Settings section (#4605)', () => {
    const settings = section('settings');
    const billingItem = settings.items.find((i) => i.href === '/settings/billing');
    expect(billingItem, 'Settings section should link to /settings/billing').toBeDefined();
    expect(billingItem?.labelKey).toBe('nav.billing');
  });

  it('has a dedicated Backup section with Backup, Cloud Backup, Disaster Recovery, in that order', () => {
    const backup = section('backup');
    expect(backup.label).toBe('Backup');
    expect(hrefsOf('backup')).toEqual(['/backup', '/c2c', '/dr']);

    const names = backup.items.map((i) => i.name);
    expect(names).toEqual(['Device Backup', 'Cloud Backup', 'Disaster Recovery']);
  });

  it('keeps Network Monitor out of Security (lives under Fleet Management)', () => {
    expect(hrefsOf('security')).not.toContain('/monitoring');
    // Security still leads with its own Security item.
    expect(section('security').items[0].href).toBe('/security');
  });

  it('groups billing surfaces under Billing and device config under Fleet Management', () => {
    expect(hrefsOf('billing')).toEqual([
      '/billing/quotes',
      '/billing/invoices',
      '/contracts',
      '/timesheet',
      '/settings/catalog',
    ]);
    expect(hrefsOf('fleet-management')).toEqual([
      '/devices/groups',
      '/configuration-policies',
      '/software',
      '/monitoring',
      '/discovery',
      '/onedrive',
    ]);
  });

  it('keeps every AI surface together and every platform-admin surface in Administration', () => {
    expect(hrefsOf('ai')).toEqual([
      '/fleet', '/workspace', '/settings/ai-agents', '/ai-agents/runs', '/ai-agents/impact', '/settings/ai-usage', '/ai-for-office',
    ]);
    const admin = section('administration');
    expect(admin.items.length).toBeGreaterThan(0);
    for (const item of admin.items) expect(item.platformAdminOnly, item.href).toBe(true);
    for (const s of navSections) {
      if (s.id === 'administration') continue;
      for (const item of s.items) expect(item.platformAdminOnly, `${s.id} > ${item.href}`).toBeFalsy();
    }
    expect(topLevelNav.map((i) => i.href)).not.toContain('/onedrive');
  });

  it('each moved href appears in exactly one section (no duplicate membership)', () => {
    const allHrefs = navSections.flatMap((s) => s.items.map((i) => i.href));
    for (const href of ['/monitoring', '/discovery', '/backup', '/c2c', '/dr']) {
      const count = allHrefs.filter((h) => h === href).length;
      expect(count, `${href} should appear exactly once across all sections`).toBe(1);
    }
  });

  it('orders sections AI -> Fleet Management -> Security -> Backup -> Billing -> Reporting -> Settings -> Administration', () => {
    expect(navSections.map((s) => s.id)).toEqual([
      'ai',
      'fleet-management',
      'security',
      'backup',
      'billing',
      'reporting',
      'settings',
      'administration',
    ]);
  });
});

describe('sidebar i18n seed', () => {
  it('renders pt-BR top-level labels when selected', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<Sidebar currentPath="/" />);

    expect(await screen.findByText('Painel')).toBeInTheDocument();
    expect(screen.getByText('Dispositivos')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders English labels by default', async () => {
    render(<Sidebar currentPath="/" />);
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('shows the row-derived pending approval count on the approvals link', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) =>
      (url === '/approvals/pending/count'
        ? { ok: true, status: 200, json: async () => ({ count: 3 }) }
        : { ok: false, status: 404, json: async () => ({}) }) as Response,
    );

    render(<Sidebar currentPath="/" />);

    const badge = await screen.findByLabelText('3 pending approvals');
    expect(badge.closest('a')).toHaveAttribute('href', '/approvals');
  });

  it('keeps the previously shown approvals count when a poll returns a malformed body', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      fetchWithAuthMock.mockImplementation(async (url: string) =>
        (url === '/approvals/pending/count'
          ? { ok: true, status: 200, json: async () => ({ count: 3 }) }
          : { ok: false, status: 404, json: async () => ({}) }) as Response,
      );

      render(<Sidebar currentPath="/" />);
      await act(async () => {});
      expect(screen.getByLabelText('3 pending approvals')).toBeInTheDocument();

      // Next poll answers 200 with an unparseable body: the count must NOT be
      // coerced to 0 (an affirmative "nothing pending") — the last good count
      // stays on screen.
      fetchWithAuthMock.mockImplementation(async (url: string) =>
        (url === '/approvals/pending/count'
          ? { ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }
          : { ok: false, status: 404, json: async () => ({}) }) as Response,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(screen.getByLabelText('3 pending approvals')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      warnSpy.mockRestore();
    }
  });

  it('gives every top-level item a key that resolves in both locales', () => {
    for (const item of topLevelNav) {
      expect(item.labelKey, `missing labelKey for ${item.name}`).toBeTruthy();
      expect(i18n.t(item.labelKey!, { lng: 'pt-BR' })).not.toBe(item.labelKey);
      expect(i18n.t(item.labelKey!, { lng: 'en' })).toBe(item.name);
    }
  });

  it('gives every section and nested item a key that resolves in both locales', () => {
    for (const navSection of navSections) {
      expect(navSection.labelKey, `missing labelKey for section ${navSection.label}`).toBeTruthy();
      expect(i18n.t(navSection.labelKey!, { lng: 'en' })).toBe(navSection.label);
      expect(i18n.t(navSection.labelKey!, { lng: 'pt-BR' })).not.toBe(navSection.labelKey);

      for (const item of navSection.items) {
        expect(item.labelKey, `missing labelKey for ${navSection.label} > ${item.name}`).toBeTruthy();
        expect(i18n.t(item.labelKey!, { lng: 'en' })).toBe(item.name);
        expect(i18n.t(item.labelKey!, { lng: 'pt-BR' })).not.toBe(item.labelKey);
      }
    }
  });

  it('keeps the English and pt-BR navigation keys in exact parity', () => {
    expect(Object.keys(ptBR.nav).sort()).toEqual(Object.keys(en.nav).sort());
  });

  it('keeps hrefs and permission identifiers stable while translating labels', async () => {
    const navigationContract = [...topLevelNav, ...navSections.flatMap((navSection) => navSection.items)]
      .map((item) => ({
        name: item.name,
        href: item.href,
        requiredPermission: item.requiredPermission,
      }));

    for (const locale of ['en', 'pt-BR']) {
      await i18n.changeLanguage(locale);
      for (const item of [...topLevelNav, ...navSections.flatMap((navSection) => navSection.items)]) {
        i18n.t(item.labelKey!);
      }

      expect([...topLevelNav, ...navSections.flatMap((navSection) => navSection.items)].map((item) => ({
        name: item.name,
        href: item.href,
        requiredPermission: item.requiredPermission,
      }))).toEqual(navigationContract);
    }
  });

  it('renders a translated nested item without changing its href', async () => {
    await i18n.changeLanguage('pt-BR');
    render(<Sidebar currentPath="/monitoring" />);

    const nestedLink = await screen.findByText('Monitoramento de Rede');
    expect(nestedLink.closest('a')).toHaveAttribute('href', '/monitoring');
    expect(screen.queryByText('Network Monitor')).not.toBeInTheDocument();
  });

  it.each(['/software-inventory', '/software-policies'])(
    'highlights the single Software item for alias path %s',
    async (path) => {
      const { container } = render(<Sidebar currentPath={path} />);
      const link = await waitFor(() => {
        const a = container.querySelector('a[href="/software"]');
        expect(a).not.toBeNull();
        return a as HTMLAnchorElement;
      });
      expect(link.className).toContain('bg-primary');
      expect(container.querySelector(`a[href="${path}"]`)).toBeNull();
    },
  );

  it('switches an already-mounted sidebar when the language changes', async () => {
    render(<Sidebar currentPath="/" />);
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();

    await i18n.changeLanguage('pt-BR');
    await waitFor(() => expect(screen.getByText('Painel')).toBeInTheDocument());
  });
});
