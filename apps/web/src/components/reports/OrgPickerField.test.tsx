import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const orgState = vi.hoisted(() => ({
  currentOrgId: null as string | null,
  organizations: [] as Array<{ id: string; partnerId: string; name: string; status: string; createdAt: string }>,
}));
vi.mock('../../stores/orgStore', () => ({ useOrgStore: () => orgState }));

import { OrgPickerField, useReportTargetOrg } from './OrgPickerField';

const org = (id: string, name: string, status = 'active') => ({
  id, partnerId: 'p-1', name, status, createdAt: '2026-01-01T00:00:00Z',
});

function Harness({ defaultOrgId }: { defaultOrgId?: string | null }) {
  const target = useReportTargetOrg(defaultOrgId);
  return (
    <div>
      <span data-testid="target">
        {JSON.stringify({ orgId: target.orgId, pickerVisible: target.pickerVisible, missing: target.missing })}
      </span>
      {target.pickerVisible && (
        <OrgPickerField value={target.pickedOrgId} onChange={target.setPickedOrgId} options={target.options} />
      )}
    </div>
  );
}

const state = () => JSON.parse(screen.getByTestId('target').textContent ?? '{}');

describe('useReportTargetOrg / OrgPickerField (multi-org report series W01)', () => {
  beforeEach(() => {
    orgState.currentOrgId = null;
    orgState.organizations = [];
  });

  it('uses the focused org and shows no picker when the switcher names one', () => {
    orgState.currentOrgId = 'org-a';
    orgState.organizations = [org('org-a', 'Acme Dental'), org('org-b', 'Bravo Law')];
    render(<Harness />);
    expect(state()).toEqual({ orgId: 'org-a', pickerVisible: false, missing: false });
    expect(screen.queryByTestId('report-org-picker')).toBeNull();
  });

  it('under All organizations with several orgs, requires a choice and then uses it', async () => {
    orgState.organizations = [org('org-b', 'Bravo Law'), org('org-a', 'Acme Dental')];
    render(<Harness />);
    expect(state()).toEqual({ orgId: null, pickerVisible: true, missing: true });

    const select = screen.getByTestId('report-org-picker-select');
    // Sorted by name, placeholder first.
    expect([...(select as HTMLSelectElement).options].map((o) => o.textContent)).toEqual([
      'Choose an organization',
      'Acme Dental',
      'Bravo Law',
    ]);
    await userEvent.setup().selectOptions(select, 'org-b');
    expect(state()).toEqual({ orgId: 'org-b', pickerVisible: true, missing: false });
  });

  it('omits out-of-service orgs and auto-uses the only creatable org', () => {
    orgState.organizations = [
      org('org-a', 'Acme Dental', 'active'),
      org('org-s', 'Suspended Co', 'suspended'),
      org('org-c', 'Churned Co', 'churned'),
    ];
    render(<Harness />);
    expect(state()).toEqual({ orgId: 'org-a', pickerVisible: false, missing: false });
  });

  it('offers only active and trial orgs when there are several', () => {
    orgState.organizations = [
      org('org-b', 'Bravo Law', 'active'),
      org('org-t', 'Trial Co', 'trial'),
      org('org-o', 'Offboarding Co', 'offboarding'),
    ];
    render(<Harness />);
    const options = [...(screen.getByTestId('report-org-picker-select') as HTMLSelectElement).options]
      .map((o) => o.value)
      .filter(Boolean);
    expect(options).toEqual(['org-b', 'org-t']);
  });

  it('asks for nothing while the org list is not loaded (the server decides, as before)', () => {
    render(<Harness />);
    expect(state()).toEqual({ orgId: null, pickerVisible: false, missing: false });
  });

  it('seeds the choice from a caller default (the templates page picker)', () => {
    orgState.organizations = [org('org-a', 'Acme Dental'), org('org-b', 'Bravo Law')];
    render(<Harness defaultOrgId="org-b" />);
    expect(state()).toEqual({ orgId: 'org-b', pickerVisible: true, missing: false });
    expect(screen.getByTestId('report-org-picker-select')).toHaveValue('org-b');
  });
});
