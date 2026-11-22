/**
 * Flows completion W01c (#12436): the shared `maxTargets` field used by the
 * conversion switch and the enable dialog.
 */
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { FleetMaxTargetsField, parseFleetMaxTargets } from './FleetMaxTargetsField';

function Harness({ partnerWide = false, initial = '' }: { partnerWide?: boolean; initial?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <FleetMaxTargetsField
      stepId="run_fleet"
      value={value}
      onChange={setValue}
      partnerWide={partnerWide}
      testIdPrefix="flow-enable-maxtargets"
      perOrgTestId="flow-enable-perorg-run_fleet"
    />
  );
}

describe('parseFleetMaxTargets', () => {
  it.each([
    [undefined, null],
    ['', null],
    ['   ', null],
    ['0', null],
    ['501', null],
    ['-1', null],
    ['1.5', null],
    ['1e2', null],
    ['abc', null],
    ['1', 1],
    [' 42 ', 42],
    ['500', 500],
  ])('parses %j as %j', (raw, expected) => {
    expect(parseFleetMaxTargets(raw)).toBe(expected);
  });
});

describe('FleetMaxTargetsField', () => {
  it('FleetMaxTargetsField marks 0 and 501 invalid and accepts 1 and 500', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId('flow-enable-maxtargets-run_fleet') as HTMLInputElement;
    // Empty is invalid: a ticked fleet step always needs a value.
    expect(screen.getByTestId('flow-enable-maxtargets-invalid-run_fleet')).toBeTruthy();

    for (const bad of ['0', '501']) {
      await user.clear(input);
      await user.type(input, bad);
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByTestId('flow-enable-maxtargets-invalid-run_fleet').textContent).toContain('500');
    }
    for (const good of ['1', '500']) {
      await user.clear(input);
      await user.type(input, good);
      expect(input.getAttribute('aria-invalid')).toBe('false');
      expect(screen.queryByTestId('flow-enable-maxtargets-invalid-run_fleet')).toBeNull();
    }
  });

  it('shows the live-membership and frozen-device copy', () => {
    render(<Harness initial="10" />);
    expect(screen.getByText(/worked out fresh on each run/i)).toBeTruthy();
    expect(screen.getByText(/approver sees the exact devices/i)).toBeTruthy();
  });

  it('per-org copy shows only for partner-wide', () => {
    const { unmount } = render(<Harness initial="10" />);
    expect(screen.queryByTestId('flow-enable-perorg-run_fleet')).toBeNull();
    unmount();
    render(<Harness initial="10" partnerWide />);
    expect(screen.getByTestId('flow-enable-perorg-run_fleet').textContent).toMatch(/each organization/i);
  });
});
