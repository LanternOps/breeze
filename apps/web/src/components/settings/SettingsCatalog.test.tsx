import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({
  perms: [] as Perm[],
  scope: 'partner' as string | null,
  toolSources: false,
}));

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(),
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ user: { isPlatformAdmin: false, permissions: state.perms } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.scope }) }));
vi.mock('../../stores/featuresStore', () => ({
  useToolSourcesGate: () => ({ enabled: state.toolSources, loaded: true }),
}));

import SettingsCatalog from './SettingsCatalog';

const hrefs = (c: HTMLElement) => [...c.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

describe('SettingsCatalog', () => {
  beforeEach(() => {
    state.perms = [{ resource: '*', action: '*' }];
    state.scope = 'partner';
    state.toolSources = false;
  });

  it('renders a grouped card per entry the user may see', () => {
    const { container } = render(<SettingsCatalog />);
    const h = hrefs(container);
    for (const href of ['/settings/roles', '/settings/filters', '/settings/api-keys', '/settings/alert-templates', '/settings/ai-agents'])
      expect(h).toContain(href);
    expect(container.querySelectorAll('[data-testid^="settings-group-"]').length).toBeGreaterThan(3);
  });

  it('hides entries the sidebar predicate would hide (permissions, scope, tool sources)', () => {
    state.perms = [{ resource: 'users', action: 'read' }];
    state.scope = 'organization';
    const { container } = render(<SettingsCatalog />);
    const h = hrefs(container);
    expect(h).toContain('/settings/users');
    expect(h).toContain('/settings/roles');
    expect(h).not.toContain('/settings/sso'); // needs sso:admin
    expect(h).not.toContain('/settings/billing'); // partner scope only
    expect(h).not.toContain('/settings/tool-sources'); // server flag off
  });

  it('shows SSO and Access Reviews once the role holds the grants (moved out of the sidebar)', () => {
    state.perms = [{ resource: 'users', action: 'read' }, { resource: 'sso', action: 'admin' }];
    const h = hrefs(render(<SettingsCatalog />).container);
    expect(h).toContain('/settings/sso');
    expect(h).toContain('/settings/access-reviews');
  });

  it('filters by search text and shows an empty state', () => {
    const { container } = render(<SettingsCatalog />);
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'variables' } });
    expect(hrefs(container)).toContain('/settings/variables');
    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'zzzzqq' } });
    expect(hrefs(container)).toEqual([]);
    expect(screen.getByTestId('settings-no-results')).toBeTruthy();
  });
});
