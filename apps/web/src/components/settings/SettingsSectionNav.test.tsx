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
});
