import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import DiscoveryProfileList, { type DiscoveryProfile } from './DiscoveryProfileList';

// The responsive table renders both a desktop <table> and a mobile card list in
// the DOM at once (the sm: breakpoint is CSS-only, invisible to jsdom), so every
// row's text/labels appear twice. Scope assertions to the desktop surface.
const desktop = () => within(screen.getByTestId('responsive-table-desktop'));

const profiles: DiscoveryProfile[] = [
  {
    id: 'profile-1',
    name: 'HQ sweep',
    subnets: ['10.0.0.0/24'],
    methods: ['icmp'],
    schedule: 'Manual',
    status: 'active'
  },
  {
    id: 'profile-2',
    name: 'Branch sweep',
    subnets: ['10.1.0.0/24'],
    methods: ['arp'],
    schedule: 'Manual',
    status: 'active'
  }
];

describe('DiscoveryProfileList', () => {
  it('disables only the running profile Run button', () => {
    render(
      <DiscoveryProfileList
        profiles={profiles}
        runningProfileId="profile-1"
        onRun={vi.fn()}
      />
    );

    expect(desktop().getByLabelText('Running HQ sweep')).toBeDisabled();
    expect(desktop().getByLabelText('Run Branch sweep')).not.toBeDisabled();
  });

  it('passes the selected profile when Run is clicked', () => {
    const onRun = vi.fn();
    render(<DiscoveryProfileList profiles={profiles} onRun={onRun} />);

    fireEvent.click(desktop().getByLabelText('Run HQ sweep'));

    expect(onRun).toHaveBeenCalledWith(profiles[0]);
  });
});
