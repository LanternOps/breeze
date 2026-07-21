import { render, screen, waitFor } from '@testing-library/react';
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
  it('has a dedicated Monitoring section with Network Monitor + Network Discovery, in that order', () => {
    const monitoring = section('monitoring');
    expect(monitoring.label).toBe('Monitoring');
    expect(hrefsOf('monitoring')).toEqual(['/monitoring', '/discovery']);

    const names = monitoring.items.map((i) => i.name);
    expect(names).toEqual(['Network Monitor', 'Network Discovery']);
  });

  it('has a dedicated Backup section with Backup, Cloud Backup, Disaster Recovery, in that order', () => {
    const backup = section('backup');
    expect(backup.label).toBe('Backup');
    expect(hrefsOf('backup')).toEqual(['/backup', '/c2c', '/dr']);

    const names = backup.items.map((i) => i.name);
    expect(names).toEqual(['Backup', 'Cloud Backup', 'Disaster Recovery']);
  });

  it('removed Network Monitor from Security (now lives only under Monitoring)', () => {
    expect(hrefsOf('security')).not.toContain('/monitoring');
    // Security still leads with its own Security item.
    expect(section('security').items[0].href).toBe('/security');
  });

  it('removed Network Discovery and all backup items from Operations', () => {
    const ops = hrefsOf('operations');
    expect(ops).not.toContain('/discovery');
    expect(ops).not.toContain('/backup');
    expect(ops).not.toContain('/c2c');
    expect(ops).not.toContain('/dr');
    // Operations retains its non-backup items (Quotes, Invoices, Contracts, Product
    // Catalog added by the billing engine).
    expect(ops).toEqual([
      '/billing/quotes',
      '/billing/invoices',
      '/contracts',
      '/timesheet',
      '/settings/catalog',
      '/software',
      '/software-inventory',
      '/configuration-policies',
      '/integrations',
    ]);
  });

  it('each moved href appears in exactly one section (no duplicate membership)', () => {
    const allHrefs = navSections.flatMap((s) => s.items.map((i) => i.href));
    for (const href of ['/monitoring', '/discovery', '/backup', '/c2c', '/dr']) {
      const count = allHrefs.filter((h) => h === href).length;
      expect(count, `${href} should appear exactly once across all sections`).toBe(1);
    }
  });

  it('orders sections AI & Fleet -> Monitoring -> Security -> Operations -> Backup -> Reporting -> Settings', () => {
    expect(navSections.map((s) => s.id)).toEqual([
      'ai-fleet',
      'monitoring',
      'security',
      'operations',
      'backup',
      'reporting',
      'settings',
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

  it('switches an already-mounted sidebar when the language changes', async () => {
    render(<Sidebar currentPath="/" />);
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();

    await i18n.changeLanguage('pt-BR');
    await waitFor(() => expect(screen.getByText('Painel')).toBeInTheDocument());
  });
});
