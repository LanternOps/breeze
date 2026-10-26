import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Perm = { resource: string; action: string };
const state = vi.hoisted(() => ({
  perms: [] as Perm[],
  scope: 'partner' as string | null,
  toolSources: false,
  extensionNav: [] as { name: string; href: string }[],
}));

vi.mock('../../stores/auth', () => ({
  registerOrgIdProvider: vi.fn(),
  fetchWithAuth: vi.fn(async()=>Response.json({autopayEnabled:false})),
  useAuthStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ user: { isPlatformAdmin: false, permissions: state.perms } }),
    { getState: () => ({ tokens: null }) },
  ),
}));
vi.mock('../../lib/authScope', () => ({ getJwtClaims: () => ({ scope: state.scope }) }));
vi.mock('../../stores/featuresStore', () => ({
  useToolSourcesGate: () => ({ enabled: state.toolSources, loaded: true }),
}));
vi.mock('../extensions/useExtensionNavigation', () => ({
  useExtensionNavigation: () => state.extensionNav,
}));

import SettingsCatalog from './SettingsCatalog';
import { SETTINGS_CATALOG } from '../../lib/settingsCatalog';

const hrefs = (c: HTMLElement) => [...c.querySelectorAll('a[href]')].map((a) => a.getAttribute('href'));

describe('SettingsCatalog', () => {
  beforeEach(() => {
    state.perms = [{ resource: '*', action: '*' }];
    state.scope = 'partner';
    state.toolSources = false;
    state.extensionNav = [];
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

  // W04 (#10135): the Settings → AI hub is a sidebar entry, not a settings screen.
  it('never renders a sidebar-only entry as a card on the index', () => {
    const { container } = render(<SettingsCatalog />);
    expect(screen.getByTestId('settings-card-ai-agents')).toBeTruthy(); // the AI group itself renders
    expect(screen.queryByTestId('settings-card-ai')).toBeNull();
    expect(hrefs(container)).not.toContain('/settings/ai');
  });

  it('the AI hub lists only AI-group cards, without the group heading, and keeps search', () => {
    const { container } = render(<SettingsCatalog group="ai" />);
    const ids = [...container.querySelectorAll('[data-testid^="settings-card-"]')].map((el) =>
      el.getAttribute('data-testid')!.replace(/^settings-card-/, ''),
    );
    expect(ids).toEqual(expect.arrayContaining(['ai-agents', 'ai-usage', 'ai-models', 'ai-script-authoring']));
    expect(ids.filter((id) => SETTINGS_CATALOG.find((e) => e.id === id)?.group !== 'ai')).toEqual([]);
    expect(ids).not.toContain('ai'); // the hub never lists itself
    expect(container.querySelectorAll('[data-testid^="settings-group-"]')).toHaveLength(1);
    expect(container.querySelector('h2')).toBeNull(); // the page title already says "AI settings"

    fireEvent.change(screen.getByTestId('settings-search'), { target: { value: 'usage' } });
    expect(hrefs(container)).toEqual(['/settings/ai-usage']);
  });

  it('hides Knowledge sources until the workspace extension contributes navigation', () => {
    state.extensionNav = [{ name: 'Other', href: '/extensions/other-ext/home' }];
    const { container, unmount } = render(<SettingsCatalog group="ai" />);
    expect(hrefs(container)).not.toContain('/extensions/workspace/sources');
    unmount();

    state.extensionNav = [{ name: 'Wisp Sources', href: '/extensions/workspace/sources' }];
    const shown = render(<SettingsCatalog group="ai" />);
    expect(hrefs(shown.container)).toContain('/extensions/workspace/sources');
    expect(screen.getByTestId('settings-card-knowledge-sources').textContent).toContain('Knowledge sources');
  });
});
