// @vitest-environment jsdom
import type { SecurityDeviceRow } from '@breeze/shared';
import { render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityDeviceTable } from './SecurityDeviceTable';

const DEVICES: SecurityDeviceRow[] = [
  {
    id: 'd-1',
    name: 'Laptop',
    protection: 'protected',
    avProducts: ['Defender'],
    realTimeProtection: true,
    definitionsAgeDays: 1,
    encryption: 'encrypted',
    firewall: true,
    pendingCriticalPatches: 0,
    observedAt: '2026-09-02T12:00:00.000Z',
  },
  {
    id: 'd-2',
    name: 'Desktop',
    protection: 'unprotected',
    avProducts: [],
    realTimeProtection: false,
    definitionsAgeDays: null,
    encryption: null,
    firewall: null,
    pendingCriticalPatches: 2,
    observedAt: null,
  },
  {
    id: 'd-3',
    name: 'Server',
    protection: 'unknown',
    avProducts: [],
    realTimeProtection: null,
    definitionsAgeDays: null,
    encryption: null,
    firewall: null,
    pendingCriticalPatches: 0,
    observedAt: null,
  },
];

it('shows four calm columns, each a scoped header', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />);

  const headers = screen.getAllByRole('columnheader');
  expect(headers.map((h) => h.textContent)).toEqual([
    'Device',
    'Protection',
    'Encryption',
    'Last checked',
  ]);
  for (const header of headers) {
    expect(header.getAttribute('scope')).toBe('col');
  }
});

it('carries exactly one status mark per row, on protection', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />);

  expect(screen.getByTestId('portal-security-device-d-1-protection').textContent).toContain(
    'Protected',
  );
  expect(screen.getByTestId('portal-security-device-d-2-protection').textContent).toContain(
    'Not protected',
  );
  expect(screen.getByTestId('portal-security-device-d-3-protection').textContent).toContain(
    'Not known',
  );
  // The status diet: one ink dot per row, and it belongs to protection.
  const row = screen.getByTestId('portal-security-device-d-1');
  expect(row.querySelectorAll('span[aria-hidden="true"].rounded-full')).toHaveLength(1);
});

it('keeps the remaining evidence behind a per-row disclosure', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />);

  const more = screen.getByTestId('portal-security-device-d-1-more');
  expect(more.tagName.toLowerCase()).toBe('details');
  expect(within(more).getByText('More about this device')).toBeTruthy();

  const text = more.textContent ?? '';
  expect(text).toContain('Defender');
  expect(text).toContain('Always-on scanning');
  expect(text).toContain('Virus definitions');
  expect(text).toContain('Firewall');
  expect(text).toContain('Important updates waiting');
  expect(
    screen.getByTestId('portal-security-device-d-1-real-time-protection').textContent,
  ).toBe('On');
  expect(
    screen.getByTestId('portal-security-device-d-2-real-time-protection').textContent,
  ).toBe('Off');
  expect(
    screen.getByTestId('portal-security-device-d-3-real-time-protection').textContent,
  ).toBe('Not known');
});

it('states the freshness once, in the organization timezone', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />);

  const observed = screen.getByTestId('portal-security-device-d-1-observed-at');
  expect(observed.textContent).toContain('Sep 2, 2026');
  expect(observed.textContent).toContain('6:00 AM MDT');
  // The formatted string already names the zone; the old copy repeated it.
  expect(observed.textContent).not.toContain('(America/Denver)');
  expect(screen.getByTestId('portal-security-device-d-2-observed-at').textContent).toBe(
    'Not known',
  );
});

it('speaks the reader language, not the technician column names', () => {
  const text =
    render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />).container
      .textContent ?? '';

  for (const jargon of ['Observed at', 'Definitions age', 'Real-time protection', 'Provider']) {
    expect(text).not.toContain(jargon);
  }
});

it('lets a long machine name wrap instead of overflowing the phone card', () => {
  render(<SecurityDeviceTable
    timezone="America/Denver"
    devices={[{
      ...DEVICES[0],
      id: 'd-long',
      name: 'ACCOUNTING-WORKSTATION-RECEPTION-DESK-0000000001.corp.example.com',
    }]}
  />);

  const name = screen.getByTestId('portal-security-device-d-long-name');
  expect(name.className).toContain('break-words');
  expect(screen.getByTestId('portal-security-device-d-long').className).toContain('flex-wrap');
});

it('totals the ledger in its foot, counting the unknowns apart from the unprotected', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} />);

  // d-3 has never reported: it is not evidence of an unprotected machine, so
  // the foot names it separately instead of folding it into the shortfall.
  expect(screen.getByTestId('security-ledger-foot').textContent).toBe(
    '1 of 3 protected \u00b7 1 not yet known',
  );
  expect(screen.queryByTestId('portal-security-devices-cap')).toBeNull();
});

it('refuses to call a silent fleet unprotected', () => {
  const silent = DEVICES.map((device, index) => ({
    ...device,
    id: `u-${index}`,
    protection: 'unknown' as const,
  }));
  render(<SecurityDeviceTable timezone="America/Denver" devices={silent} />);

  expect(screen.getByTestId('security-ledger-foot').textContent).toBe(
    'Protection not yet known for all 3 devices',
  );
});

it('keeps the single-machine account in the singular when nothing is known yet', () => {
  render(<SecurityDeviceTable
    timezone="America/Denver"
    devices={[{ ...DEVICES[2], id: 'only' }]}
  />);

  expect(screen.getByTestId('security-ledger-foot').textContent).toBe(
    'Protection not yet known for your device',
  );
});

it('states the plain shortfall when every machine has actually reported', () => {
  render(<SecurityDeviceTable
    timezone="America/Denver"
    devices={[DEVICES[0], DEVICES[1]]}
  />);

  expect(screen.getByTestId('security-ledger-foot').textContent).toBe(
    '1 of 2 devices protected',
  );
});

it('says honestly when the ledger only shows the first page of the fleet', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={DEVICES} total={240} />);

  expect(screen.getByTestId('portal-security-devices-cap').textContent).toBe(
    'Showing the first 3 of 240 devices',
  );
});

it('greets an empty fleet with the ruled empty state, not a bare line', () => {
  render(<SecurityDeviceTable timezone="America/Denver" devices={[]} />);

  const empty = screen.getByTestId('portal-security-devices-empty');
  expect(empty.className).toContain('border-y');
  expect(empty.textContent).toContain('No devices yet');
  expect(screen.queryByRole('table')).toBeNull();
});
