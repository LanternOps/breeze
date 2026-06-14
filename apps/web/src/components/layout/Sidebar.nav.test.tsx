import { describe, it, expect } from 'vitest';

// Mock the stores so importing Sidebar.tsx (which the navSections export lives
// in) doesn't pull in real auth/ui store side effects.
import { vi } from 'vitest';
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: { getState: () => ({ tokens: null }) },
}));
vi.mock('../../stores/uiStore', () => ({
  useUiStore: vi.fn(() => ({ isMobileMenuOpen: false, closeMobileMenu: vi.fn() })),
}));

import { navSections } from './Sidebar';

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
    // Operations retains its non-backup items.
    expect(ops).toEqual([
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
