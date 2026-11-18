import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InheritanceTabDto } from '@breeze/shared';
import '@/lib/i18n';
import InheritanceLine from './InheritanceLine';
import { PartnerInheritanceContext, type PartnerInheritanceUi } from './inheritanceContext';
import type { TabInheritanceState } from './useTabInheritance';
import PartnerDefaultsTab from '../PartnerDefaultsTab';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn(), useAuthStore: () => undefined }));

const DEFAULTS: InheritanceTabDto = {
  tab: 'defaults',
  orgCount: 42,
  fields: [
    { id: 'defaults.agentUpdatePolicy', kind: 'locks', partnerSet: true, inForce: true, platformDefault: 'staged', sealed: false, counts: { ownValue: 3, overrides: 0, shadowed: 3 } },
    { id: 'defaults.maintenanceWindow', kind: 'locks', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
    { id: 'defaults.agentVersionPins.agent', kind: 'overridable', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 2, overrides: 0, shadowed: 0 } },
    { id: 'defaults.agentVersionPins.watchdog', kind: 'overridable', partnerSet: false, inForce: false, platformDefault: null, sealed: false, counts: { ownValue: 0, overrides: 0, shadowed: 0 } },
    { id: 'defaults.defaultEnrollmentTtlMinutes', kind: 'overridable', qualifier: 'cap', partnerSet: false, inForce: false, platformDefault: 43200, sealed: false, counts: { ownValue: 4, overrides: 0, shadowed: 0, clamped: 0 } },
    { id: 'defaults.defaultEnrollmentDeviceCount', kind: 'overridable', partnerSet: true, inForce: true, platformDefault: 50, sealed: false, counts: { ownValue: 4, overrides: 4, shadowed: 0 } },
    { id: 'defaults.maxEnrollmentLinkTtlMinutes', kind: 'partnerOnly', partnerSet: false, inForce: false, platformDefault: 525600, sealed: false, counts: null },
  ],
};

function ui(tabState: TabInheritanceState | null, over: Partial<PartnerInheritanceUi> = {}): PartnerInheritanceUi {
  return { tabState, savedSetting: () => undefined, isFieldDirty: () => false, openDrill: vi.fn(), selectedFieldId: null, ...over };
}

function renderLine(fieldId: string, value: PartnerInheritanceUi) {
  return render(
    <PartnerInheritanceContext.Provider value={value}>
      <InheritanceLine fieldId={fieldId} />
    </PartnerInheritanceContext.Provider>,
  );
}

const line = (id: string) => screen.getByTestId(`partner-settings-line-${id}`);

describe('InheritanceLine', () => {
  it('renders the summary with the platform default label', () => {
    renderLine('defaults.defaultEnrollmentTtlMinutes', ui({ status: 'ok', data: DEFAULTS }));
    expect(line('defaults.defaultEnrollmentTtlMinutes').textContent)
      .toBe('Not set. Orgs use the platform default (30 days) · 4 set their own');
  });

  it('the count is a button that opens the drill-down for its bucket', () => {
    const value = ui({ status: 'ok', data: DEFAULTS });
    renderLine('defaults.agentUpdatePolicy', value);
    fireEvent.click(screen.getByRole('button', { name: '3 had their own value' }));
    expect(value.openDrill).toHaveBeenCalledWith('defaults.agentUpdatePolicy', 'shadowed');
  });

  it('restricted state renders badges without counts', () => {
    render(
      <PartnerInheritanceContext.Provider value={ui({ status: 'restricted' })}>
        <PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />
      </PartnerInheritanceContext.Provider>,
    );
    expect(screen.getByTestId('partner-settings-badge-defaults.agentUpdatePolicy')).toHaveTextContent('Locks orgs');
    expect(line('defaults.agentUpdatePolicy').textContent).toBe('Org breakdown requires full partner access');
    expect(screen.queryByRole('button', { name: /had their own value/ })).toBeNull();
  });

  it('unavailable renders nothing (badge only)', () => {
    const { container } = renderLine('defaults.agentUpdatePolicy', ui({ status: 'unavailable' }));
    expect(container).toBeEmptyDOMElement();
  });

  it('loading and outside the page render nothing', () => {
    expect(renderLine('defaults.agentUpdatePolicy', ui({ status: 'loading' })).container).toBeEmptyDOMElement();
    expect(render(<InheritanceLine fieldId="defaults.agentUpdatePolicy" />).container).toBeEmptyDOMElement();
  });

  it('an unsaved draft prefixes Saved value', () => {
    renderLine('defaults.defaultEnrollmentDeviceCount', ui({ status: 'ok', data: DEFAULTS }, { isFieldDirty: id => id === 'defaults.defaultEnrollmentDeviceCount' }));
    expect(line('defaults.defaultEnrollmentDeviceCount').textContent).toBe('Saved value: Default for 42 orgs · 4 override');
  });

  it('every badged Defaults field gets its line', () => {
    render(
      <PartnerInheritanceContext.Provider value={ui({ status: 'ok', data: DEFAULTS })}>
        <PartnerDefaultsTab data={{}} onChange={vi.fn()} pinnableVersions={null} />
      </PartnerInheritanceContext.Provider>,
    );
    for (const f of DEFAULTS.fields) expect(line(f.id)).toBeInTheDocument();
    expect(line('defaults.maxEnrollmentLinkTtlMinutes').textContent).toBe('Platform default (365 days) applies to all orgs');
  });
});
