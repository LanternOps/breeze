import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import ManagementControllerCard from './ManagementControllerCard';
import { component } from './hardwareHealth.fixtures';

const assetId = '44444444-4444-4444-8444-444444444444';

const bmc = (attributes: Record<string, unknown> = {}) => component({
  componentKey: 'bmc:ipmi', componentType: 'bmc', source: 'ipmi', name: 'iDRAC', firmware: '2.80',
  attributes: { vendor: 'Dell', ip: '192.0.2.10', mac: '02:00:00:00:00:10', ...attributes },
});

it('shows vendor, firmware, IP and MAC, linking only the asset page', () => {
  render(<ManagementControllerCard component={bmc({ bmcLink: { status: 'already_linked', assetId } })} />);
  const card = screen.getByTestId('hardware-management-controller-card');
  expect(card).toHaveTextContent('Management controller');
  expect(card).toHaveTextContent('Dell');
  expect(card).toHaveTextContent('2.80');
  expect(card).toHaveTextContent('02:00:00:00:00:10');
  expect(screen.getByTestId('hardware-bmc-asset-link')).toHaveAttribute('href', `/devices/network/${assetId}`);
  expect(screen.getByTestId('hardware-bmc-asset-link')).toHaveTextContent('192.0.2.10');
});

it('shows the other-site note without suggesting a host identity link', () => {
  render(<ManagementControllerCard component={bmc({ bmcLink: { status: 'other_site', siteName: 'Secondary site' } })} />);
  expect(screen.getByTestId('hardware-bmc-other-site')).toHaveTextContent('Management controller found in site Secondary site');
  expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
});

it.each(['no_asset', 'suppressed', 'already_linked'])('shows plain IP for %s without a verified asset id', status => {
  render(<ManagementControllerCard component={bmc({ bmcLink: { status } })} />);
  expect(screen.getByTestId('hardware-bmc-ip')).toHaveTextContent('192.0.2.10');
  expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
});

it('handles absent optional facts and rejects malformed link metadata', () => {
  render(<ManagementControllerCard component={component({
    componentType: 'bmc', name: 'BMC', firmware: null,
    attributes: { ip: 'javascript:alert(1)', bmcLink: { status: 'linked', assetId: '../../settings' } },
  })} />);
  expect(screen.queryByTestId('hardware-bmc-asset-link')).not.toBeInTheDocument();
  expect(screen.getByTestId('hardware-management-controller-card')).toHaveTextContent('BMC');
});

const catalogs = import.meta.glob<{ hardwareHealth?: Record<string, string> }>('../../../locales/*/devices.json', {
  eager: true, import: 'default',
});

it.each(Object.entries(catalogs))('defines every BMC key in %s', (_path, catalog) => {
  for (const key of ['managementController', 'bmcVendor', 'bmcFirmware', 'bmcIp', 'bmcMac', 'bmcOtherSite', 'bmcObserved',
    'bmcHost', 'bmcAgentReport', 'bmcAssociation', 'bmcConfirmUnlink']) {
    expect(catalog.hardwareHealth?.[key], key).toEqual(expect.any(String));
    expect(catalog.hardwareHealth?.[key]?.trim().length, key).toBeGreaterThan(0);
  }
});
