import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The tabs have their own suites; stub them so this suite tests only the
// tab shell and URL sync (and makes no network calls).
vi.mock('./ConnectionsTab', () => ({ default: () => <div data-testid="connections-tab-stub" /> }));
vi.mock('./DeprecationsTab', () => ({ default: () => <div data-testid="deprecations-tab-stub" /> }));

import SystemPage, { parseSystemTab } from './SystemPage';

beforeEach(() => {
  window.history.replaceState(null, '', '/admin/system');
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('parseSystemTab', () => {
  it('defaults to connections and accepts only known tabs', () => {
    expect(parseSystemTab(null)).toBe('connections');
    expect(parseSystemTab(undefined)).toBe('connections');
    expect(parseSystemTab('connections')).toBe('connections');
    expect(parseSystemTab('deprecations')).toBe('deprecations');
    expect(parseSystemTab('DEPRECATIONS')).toBe('connections');
    expect(parseSystemTab('<script>')).toBe('connections');
  });
});

describe('SystemPage', () => {
  it('renders the page title and opens Connections by default', () => {
    render(<SystemPage />);
    expect(screen.getByRole('heading', { level: 1, name: 'System' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Connections' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Deprecations' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByTestId('connections-tab-stub')).toBeTruthy();
    expect(screen.queryByTestId('deprecations-tab-stub')).toBeNull();
  });

  it('opens the tab named by the URL (?tab=deprecations via initialTab)', () => {
    window.history.replaceState(null, '', '/admin/system?tab=deprecations');
    render(<SystemPage initialTab={parseSystemTab(new URLSearchParams(window.location.search).get('tab'))} />);
    expect(screen.getByRole('tab', { name: 'Deprecations' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('deprecations-tab-stub')).toBeTruthy();
    expect(screen.queryByTestId('connections-tab-stub')).toBeNull();
  });

  it('switching tabs swaps the panel and writes the tab into the URL', () => {
    window.history.replaceState(null, '', '/admin/system?orgId=abc#top');
    render(<SystemPage />);
    fireEvent.click(screen.getByRole('tab', { name: 'Deprecations' }));
    expect(screen.getByTestId('deprecations-tab-stub')).toBeTruthy();
    expect(window.location.pathname).toBe('/admin/system');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('deprecations');
    expect(new URLSearchParams(window.location.search).get('orgId')).toBe('abc');
    expect(window.location.hash).toBe('#top');

    fireEvent.click(screen.getByRole('tab', { name: 'Connections' }));
    expect(screen.getByTestId('connections-tab-stub')).toBeTruthy();
    expect(new URLSearchParams(window.location.search).has('tab')).toBe(false);
    expect(new URLSearchParams(window.location.search).get('orgId')).toBe('abc');
  });

  it('links the tabpanel to the selected tab for assistive tech', () => {
    render(<SystemPage initialTab="deprecations" />);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe('system-tab-deprecations');
    expect(screen.getByRole('tablist').getAttribute('aria-label')).toBe('System sections');
  });
});
