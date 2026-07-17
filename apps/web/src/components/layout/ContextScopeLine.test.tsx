import { render, screen } from '@testing-library/react';
import '../../lib/i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import ContextScopeLine from './ContextScopeLine';

let mockStoreState: {
  currentOrgId: string | null;
  allOrgs: boolean;
  organizations: Array<{ id: string; name: string }>;
};

vi.mock('../../stores/orgStore', () => ({
  useOrgStore: (selector: (s: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

const originalLocation = window.location;

function stubPathname(pathname: string) {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { ...originalLocation, pathname },
  });
}

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
});

beforeEach(() => {
  mockStoreState = {
    currentOrgId: 'org-1',
    allOrgs: false,
    organizations: [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Beta' }],
  };
});

describe('ContextScopeLine', () => {
  it('states the catalog contract on catalog routes regardless of context', () => {
    stubPathname('/scripts');
    render(<ContextScopeLine />);
    const line = screen.getByTestId('context-scope-line');
    expect(line.getAttribute('data-kind')).toBe('catalog');
    expect(line.textContent).toContain('Catalog — same for every organization');
  });

  it('renders nothing on an org-or-all page in org view (the switcher already says it)', () => {
    stubPathname('/devices');
    render(<ContextScopeLine />);
    expect(screen.queryByTestId('context-scope-line')).toBeNull();
  });

  it('states fleet view on an org-or-all page when All organizations is chosen', () => {
    stubPathname('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = true;
    render(<ContextScopeLine />);
    const line = screen.getByTestId('context-scope-line');
    expect(line.getAttribute('data-kind')).toBe('fleet');
    expect(line.textContent).toContain('Showing all organizations');
  });

  it('renders nothing for a transient null (not yet resolved context)', () => {
    stubPathname('/devices');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = false;
    render(<ContextScopeLine />);
    expect(screen.queryByTestId('context-scope-line')).toBeNull();
  });

  it('prompts on an org-required page in fleet view', () => {
    stubPathname('/monitoring');
    mockStoreState.currentOrgId = null;
    mockStoreState.allOrgs = true;
    render(<ContextScopeLine />);
    expect(screen.getByTestId('context-scope-line').getAttribute('data-kind')).toBe('org-required');
  });

  it('renders nothing on partner-settings pages', () => {
    stubPathname('/settings/users');
    render(<ContextScopeLine />);
    expect(screen.queryByTestId('context-scope-line')).toBeNull();
  });
});
