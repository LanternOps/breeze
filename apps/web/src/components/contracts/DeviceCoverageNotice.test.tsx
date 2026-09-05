import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { i18n } from '@/lib/i18n';
import DeviceCoverageNotice, { formatUncoveredBreakdown } from './DeviceCoverageNotice';
import { devicesUrlForRole } from './deviceCoverageLinks';

const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('DeviceCoverageNotice (#3205, links #3205 W06)', () => {
  it('renders nothing when not applicable', () => {
    const { container } = render(<DeviceCoverageNotice uncovered={null} orgId={ORG} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms full coverage at zero', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 0, byRole: {} }} orgId={ORG} />);
    expect(screen.getByTestId('contract-coverage-ok')).toBeInTheDocument();
  });

  it('renders one link per bucket, largest first, pointing at the devices list', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 5, byRole: { printer: 2, unknown: 3 } }} orgId={ORG} />);
    const links = screen.getAllByTestId('contract-coverage-role-link') as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual(['3 Unknown', '2 Printer']);
    expect(links[0]!.getAttribute('href')).toBe(devicesUrlForRole('unknown', ORG));
    expect(links[1]!.getAttribute('href')).toBe(devicesUrlForRole('printer', ORG));
    expect(screen.getByTestId('contract-coverage-warning').textContent).toContain('5');
  });

  it('without an org the links still work, without the orgId fragment', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 3, byRole: { unknown: 3 } }} orgId={null} />);
    const link = screen.getByTestId('contract-coverage-role-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(devicesUrlForRole('unknown', null));
    expect(link.getAttribute('href')).not.toContain('orgId=');
  });

  it('a rogue role renders as plain text; the other buckets stay links', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 4, byRole: { toaster: 3, server: 1 } }} orgId={ORG} />);
    expect(screen.getAllByTestId('contract-coverage-role-link')).toHaveLength(1);
    expect(screen.getByTestId('contract-coverage-warning').textContent).toContain('3 toaster');
  });

  it('renders one anchor per role bucket, interleaved with the localized list separator', () => {
    render(<DeviceCoverageNotice uncovered={{ total: 3, byRole: { server: 2, printer: 1 } }} orgId={ORG} />);
    const links = screen.getAllByTestId('contract-coverage-role-link');

    expect(links).toHaveLength(2);
    expect(links.map((link) => link.textContent)).toEqual(['2 Server', '1 Printer']);
    expect(links[0]!.parentElement!.firstChild).toBe(links[0]);
    expect(links[1]!.parentElement!.firstChild!.textContent).toBe(
      i18n.t('lists.separator', { ns: 'common' }),
    );
    expect(links[1]!.parentElement!.lastChild).toBe(links[1]);
  });

  it('renders role labels from the devices namespace', () => {
    const originalLabel = i18n.t('deviceList.roles.server', { ns: 'devices' });
    i18n.addResource('en', 'devices', 'deviceList.roles.server', 'Sentinel Server Role');

    try {
      render(<DeviceCoverageNotice uncovered={{ total: 2, byRole: { server: 2 } }} orgId={ORG} />);
      expect(screen.getByTestId('contract-coverage-role-link')).toHaveTextContent('2 Sentinel Server Role');
    } finally {
      i18n.addResource('en', 'devices', 'deviceList.roles.server', originalLabel);
    }
  });

  it('formatUncoveredBreakdown still returns the joined string for the generate toast', () => {
    expect(formatUncoveredBreakdown({ access_point: 1, server: 4 })).toBe('4 Server, 1 Access Point');
  });
});
