import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Building2, Shield } from 'lucide-react';
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
});
