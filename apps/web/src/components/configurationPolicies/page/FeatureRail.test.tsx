import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { i18n } from '@/lib/i18n';
import FeatureRail from './FeatureRail';
import type { FeatureLink, FeatureType } from '../featureTabs/types';

const link = (featureType: FeatureType): FeatureLink => ({
  id: `link-${featureType}`,
  featureType,
  featurePolicyId: null,
  inlineSettings: {},
});

const renderRail = (overrides: Partial<React.ComponentProps<typeof FeatureRail>> = {}) => {
  const onNavigate = vi.fn();
  const utils = render(
    <FeatureRail
      activeKey="patch"
      ownLinks={[]}
      parentLinks={[]}
      isGated={() => false}
      dirtyKey={null}
      onNavigate={onNavigate}
      {...overrides}
    />,
  );
  return { ...utils, onNavigate };
};

describe('FeatureRail (#12469)', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('the rail lists 26 features in six groups with Compliance Status at the foot', () => {
    renderRail();
    const nav = screen.getByRole('navigation', { name: 'Policy features' });
    const links = within(nav).getAllByRole('link');
    expect(links).toHaveLength(27);
    expect(links[links.length - 1]).toHaveAttribute('data-testid', 'config-policy-rail-tab-compliance_status');
    expect(links[links.length - 1]).toHaveAccessibleName('Compliance Status');
    const groupLabels = within(nav)
      .getAllByText((_, el) => el?.tagName === 'P')
      .map((el) => el.textContent);
    expect(groupLabels).toEqual([
      'Updates & software',
      'Monitoring',
      'Security',
      'Backup',
      'Access & end user',
      'Lifecycle',
      'Results',
    ]);
    // Below lg the same entries render as a picker.
    expect(screen.getAllByRole('option')).toHaveLength(27);
  });

  it("the rail announces each feature's state", () => {
    renderRail({
      ownLinks: [link('patch'), link('backup')],
      parentLinks: [link('backup'), link('pam')],
      isGated: (ft) => ft === 'onedrive_helper',
    });
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName('Patches, Set here');
    expect(screen.getByTestId('config-policy-rail-tab-backup')).toHaveAccessibleName('Backup, Changed here');
    expect(screen.getByTestId('config-policy-rail-tab-pam')).toHaveAccessibleName('Privileged Access, From parent');
    expect(screen.getByTestId('config-policy-rail-tab-monitors')).toHaveAccessibleName('Monitors, Not set');
    expect(screen.getByTestId('config-policy-rail-tab-onedrive_helper')).toHaveAccessibleName(
      'OneDrive Helper, Unavailable on this policy',
    );
    // The state is shown as text, not only announced.
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveTextContent('Set here');
    // Compliance Status is a results view: no state line.
    expect(screen.getByTestId('config-policy-rail-tab-compliance_status')).toHaveAccessibleName('Compliance Status');
  });

  it('the rail item of a dirty feature shows the unsaved dot', () => {
    renderRail({ ownLinks: [link('patch')], dirtyKey: 'patch' });
    expect(screen.getByTestId('config-policy-rail-tab-patch')).toHaveAccessibleName(
      'Patches (unsaved changes), Set here',
    );
    expect(screen.getByTestId('config-policy-rail-tab-monitors')).toHaveAccessibleName('Monitors, Not set');
  });

  it('selecting a feature writes the hash: each item links to #<featureType> and reports its key', () => {
    const { onNavigate } = renderRail();
    const pam = screen.getByTestId('config-policy-rail-tab-pam');
    expect(pam).toHaveAttribute('href', '#pam');
    expect(screen.getByTestId('config-policy-rail-tab-onedrive_helper')).toHaveAttribute('href', '#onedrive_helper');
    fireEvent.click(pam);
    expect(onNavigate).toHaveBeenCalledWith('pam');
    fireEvent.change(screen.getByLabelText('Policy feature'), { target: { value: 'compliance_status' } });
    expect(onNavigate).toHaveBeenCalledWith('compliance_status');
  });

  it('marks the open feature as current', () => {
    renderRail({ activeKey: 'wake_on_lan' });
    expect(screen.getByTestId('config-policy-rail-tab-wake_on_lan')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('config-policy-rail-tab-patch')).not.toHaveAttribute('aria-current');
  });
});
