import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@/lib/i18n';
import SettingBadge from './SettingBadge';
import BadgeLegend from './BadgeLegend';
import { PartnerInheritanceContext, type PartnerInheritanceUi } from './inheritanceContext';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: () => undefined }));

function ui(savedSettings: Record<string, unknown>): PartnerInheritanceUi {
  return {
    tabState: null,
    savedSetting: path => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), savedSettings),
    isFieldDirty: () => false,
    openDrill: () => {},
    selectedFieldId: null,
  };
}

const badgeText = (id: string) => screen.getByTestId(`partner-settings-badge-${id}`).textContent;

describe('SettingBadge: text per kind and qualifier (spec §5.3)', () => {
  it.each([
    ['locks', 'security.requireMfa', 'Locks orgs'],
    ['locks + conditional', 'eventLogs', 'Locks orgs when enabled'],
    ['overridable', 'defaults.defaultEnrollmentDeviceCount', 'Org can override'],
    ['partnerOnly', 'networkProxy.dedicatedTunnelOrigin', 'Partner-wide'],
  ])('%s', (_kind, id, text) => {
    render(<SettingBadge fieldId={id} />);
    expect(badgeText(id)).toBe(text);
  });

  it('overridable + cap names the ceiling from the cap field’s saved value', () => {
    render(
      <PartnerInheritanceContext.Provider value={ui({ defaults: { maxEnrollmentLinkTtlMinutes: 43200 } })}>
        <SettingBadge fieldId="defaults.defaultEnrollmentTtlMinutes" />
      </PartnerInheritanceContext.Provider>,
    );
    expect(badgeText('defaults.defaultEnrollmentTtlMinutes')).toBe('Org can override, up to 30 days');
  });

  it('overridable + cap falls back to the platform ceiling when the cap is not saved', () => {
    render(<SettingBadge fieldId="defaults.defaultEnrollmentTtlMinutes" />);
    expect(badgeText('defaults.defaultEnrollmentTtlMinutes')).toBe('Org can override, up to 365 days');
  });

  it('unclassified renders no badge', () => {
    const { container } = render(<SettingBadge fieldId="security.minLength" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('an unknown id renders nothing', () => {
    const { container } = render(<SettingBadge fieldId="nope.never" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the badge explains itself through a named help trigger', () => {
    render(<SettingBadge fieldId="security.requireMfa" />);
    expect(screen.getByRole('button', { name: 'About “Locks orgs”' })).toBeInTheDocument();
  });
});

describe('BadgeLegend', () => {
  it('lists each badge kind the tab uses, once', () => {
    render(<BadgeLegend tab="defaults" />);
    const legend = screen.getByTestId('partner-settings-badge-legend');
    expect(legend.textContent).toContain('Locks orgs');
    expect(legend.textContent).toContain('Org can override');
    expect(legend.textContent).toContain('Partner-wide');
    expect(legend.textContent?.match(/Locks orgs/g)).toHaveLength(1);
  });

  it('renders nothing on a tab without badged fields', () => {
    for (const tab of ['company', 'branding', 'knownGuests', 'modules'] as const) {
      const { container, unmount } = render(<BadgeLegend tab={tab} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });
});
