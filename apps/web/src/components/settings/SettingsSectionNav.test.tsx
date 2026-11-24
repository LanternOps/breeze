import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Building2, Shield, Ticket } from 'lucide-react';
import '@/lib/i18n';

import SettingsSectionNav, { type SettingsNavGroup } from './SettingsSectionNav';

const groups: SettingsNavGroup[] = [
  {
    label: 'Organization',
    items: [
      { key: 'company', hash: 'company', label: 'Company', description: 'Name and address', icon: Building2 },
      { key: 'security', hash: 'security', label: 'Security', description: 'Passwords and MFA', icon: Shield, dirty: true },
    ],
  },
];

const renderNav = (activeKey = 'company') =>
  render(
    <SettingsSectionNav groups={groups} activeKey={activeKey} onNavigate={vi.fn()} selectId="nav-select" testIdPrefix="nav" />,
  );

describe('SettingsSectionNav (#9168)', () => {
  it('names a dirty section in the phone select with words, not a bare bullet', () => {
    renderNav();
    const option = screen.getByRole('option', { name: /Security/ });
    expect(option.textContent).not.toContain('•');
    expect(option.textContent).toBe('Security (unsaved changes)');
    // A clean section stays just its label.
    expect(screen.getByRole('option', { name: 'Company' }).textContent).toBe('Company');
  });

  it('marks the active rail item with a left accent border, not just heavier text', () => {
    renderNav('company');
    const active = screen.getByTestId('nav-tab-company');
    const inactive = screen.getByTestId('nav-tab-security');
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(active).toHaveClass('border-l-2', 'border-primary');
    // Inactive items reserve the same border width (transparent) so the label
    // does not shift when a section becomes active.
    expect(inactive).toHaveClass('border-l-2', 'border-transparent');
    expect(inactive).not.toHaveClass('border-primary');
  });

  it('bounds the sticky rail to the visible scrollport and lets it scroll (#9171)', () => {
    renderNav();
    const rail = screen.getByRole('navigation');
    // 100vh - app header (4rem) - sticky offset top-6 (1.5rem) - main bottom padding (1.5rem).
    expect(rail).toHaveClass('lg:sticky', 'lg:max-h-[calc(100vh-7rem)]', 'lg:overflow-y-auto');
  });

  it('scrolls the active rail item into view, nearest only, when the active tab changes (#9171)', () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { rerender } = renderNav('company');
      scrollIntoView.mockClear();
      rerender(
        <SettingsSectionNav groups={groups} activeKey="security" onNavigate={vi.fn()} selectId="nav-select" testIdPrefix="nav" />,
      );
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      expect(scrollIntoView.mock.instances[0]).toBe(screen.getByTestId('nav-tab-security'));
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  // The CSS bound (100vh - 7rem) only fits once the rail is stuck. Before that
  // it sits under the page title and its bottom ran off-screen, hiding the last
  // sections until the page was scrolled. Size it from where it actually is.
  it('sizes the rail from its on-screen top so its bottom never runs past the viewport', () => {
    const { container } = render(
      <main>
        <SettingsSectionNav groups={groups} activeKey="company" onNavigate={vi.fn()} selectId="nav-select" />
      </main>,
    );
    const rail = container.querySelector('nav') as HTMLElement;
    const main = container.querySelector('main') as HTMLElement;
    let top = 194;
    rail.getBoundingClientRect = () => ({ top } as DOMRect);
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(rail.style.maxHeight).toBe('682px'); // 900 - 194 - 24

    top = 88; // scrolled until stuck at top-6 under the 4rem app header
    act(() => { main.dispatchEvent(new Event('scroll')); });
    expect(rail.style.maxHeight).toBe('788px');
  });

  describe('link items (#9787)', () => {
    const linkGroups: SettingsNavGroup[] = [
      {
        label: 'Comms',
        items: [
          { key: 'company', hash: 'company', label: 'Company', description: 'Name', icon: Building2 },
          { key: 'ticketing', hash: 'ticketing', label: 'Ticketing', description: 'Tickets', icon: Ticket, href: '/settings/ticketing', dirty: true },
        ],
      },
    ];

    it('link item renders a real href', () => {
      const onNavigate = vi.fn();
      render(<SettingsSectionNav groups={linkGroups} activeKey="ticketing" onNavigate={onNavigate} selectId="nav-select" testIdPrefix="nav" />);
      const link = screen.getByTestId('nav-tab-ticketing');
      expect(link.getAttribute('href')).toBe('/settings/ticketing');
      expect(link.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      // Never current, never dirty, even when the caller says so.
      expect(link).not.toHaveAttribute('aria-current');
      expect(link.getAttribute('aria-label')).toBe('Ticketing');
      fireEvent.click(link);
      expect(onNavigate).not.toHaveBeenCalled();
    });

    it('select option for a link item assigns location and leaves the selection unchanged', () => {
      const onNavigate = vi.fn();
      const assign = vi.fn();
      const original = window.location;
      Object.defineProperty(window, 'location', { configurable: true, value: { ...original, assign } });
      try {
        render(<SettingsSectionNav groups={linkGroups} activeKey="company" onNavigate={onNavigate} selectId="nav-select" testIdPrefix="nav" />);
        const select = screen.getByRole('combobox') as HTMLSelectElement;
        fireEvent.change(select, { target: { value: 'ticketing' } });
        expect(assign).toHaveBeenCalledWith('/settings/ticketing');
        expect(onNavigate).not.toHaveBeenCalled();
        expect(select.value).toBe('company');
      } finally {
        Object.defineProperty(window, 'location', { configurable: true, value: original });
      }
    });
  });
});

// D15 (#12469): an optional status line. The first case pins that callers who
// pass no status render exactly as before.
describe('SettingsSectionNav — status slot (#12469)', () => {
  it('callers without status render as before', () => {
    renderNav();
    const company = screen.getByTestId('nav-tab-company');
    expect(company).toHaveAccessibleName('Company');
    expect(company).toHaveTextContent('Name and address');
    expect(screen.getByTestId('nav-tab-security')).toHaveAccessibleName('Security (unsaved changes)');
    expect(screen.getByRole('option', { name: 'Company' }).textContent).toBe('Company');
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Settings sections');
    expect(screen.getByLabelText('Settings section').tagName).toBe('SELECT');
  });

  it('status replaces the description and joins the accessible name', () => {
    const withStatus: SettingsNavGroup[] = [
      {
        label: 'Security',
        items: [
          { key: 'patch', hash: 'patch', label: 'Patches', description: 'Patch settings', icon: Shield, status: 'Set here' },
          { key: 'pam', hash: 'pam', label: 'PAM', description: 'Elevation', icon: Shield, status: 'Not set', dirty: true },
        ],
      },
    ];
    render(
      <SettingsSectionNav
        groups={withStatus}
        activeKey="patch"
        onNavigate={vi.fn()}
        selectId="rail-select"
        testIdPrefix="rail"
        navLabel="Policy features"
        selectLabel="Policy feature"
      />,
    );
    const patch = screen.getByTestId('rail-tab-patch');
    expect(patch).toHaveTextContent('Set here');
    expect(patch).not.toHaveTextContent('Patch settings');
    expect(patch).toHaveAccessibleName('Patches, Set here');
    expect(screen.getByTestId('rail-tab-pam')).toHaveAccessibleName('PAM (unsaved changes), Not set');
    // Below lg the option text is all a screen reader gets.
    expect(screen.getByRole('option', { name: 'Patches, Set here' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'PAM (unsaved changes), Not set' })).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toHaveAccessibleName('Policy features');
    expect(screen.getByLabelText('Policy feature').tagName).toBe('SELECT');
  });
});
