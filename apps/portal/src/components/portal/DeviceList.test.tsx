// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnrichedPortalDevice } from '@breeze/shared';

// Resolving the full API module pulls in Astro's virtual transitions module,
// which is unavailable under Vitest. Keep the browser-facing path contract
// represented directly in this component test.
vi.mock('@/lib/api', () => ({
  publicApiPath: (path: string) => `/api/v1${path}`,
}));

import { DeviceList } from './DeviceList';

// The API hands the portal a formatted stamp in the org's timezone
// (services/portal/deviceReadModel.ts), not an ISO instant — these fixtures
// are the real shape.
const laptop: EnrichedPortalDevice = {
  id: 'd-1',
  hostname: 'laptop-01',
  displayName: 'Front desk laptop',
  osType: 'macos',
  osVersion: '15.1',
  status: 'online',
  lastSeenAt: 'Sep 3, 2026, 11:55 AM UTC',
  lastPatchAt: 'Aug 31, 2026, 6:00 PM UTC',
  protection: 'protected',
  encryption: 'encrypted',
  lastBackupAt: 'Sep 2, 2026, 2:00 AM UTC',
  warrantyEndsAt: '2027-01-01',
};

const server: EnrichedPortalDevice = {
  id: 'd-2',
  hostname: 'server-01',
  displayName: null,
  osType: 'windows',
  osVersion: '11',
  status: 'offline',
  lastSeenAt: null,
  lastPatchAt: null,
  protection: 'unprotected',
  encryption: 'unencrypted',
  lastBackupAt: null,
  warrantyEndsAt: null,
};

afterEach(() => vi.useRealTimers());

describe('DeviceList', () => {
  it('keeps five visible columns and never clips the ledger behind a scroll', () => {
    render(<DeviceList devices={[laptop]} />);

    const table = screen.getByTestId('portal-device-table');
    expect(
      Array.from(table.querySelectorAll('th')).map((th) => th.textContent?.trim())
    ).toEqual(['Device', 'Type', 'Status', 'Last online', 'Protection']);
    // A min-width wider than the 64rem content column is what hid "Warranty
    // ends" behind a horizontal scroll with no affordance.
    expect(table.className).not.toMatch(/min-w-/);
  });

  it('says when a device was last online in words, keeping the exact stamp on hover', () => {
    vi.useFakeTimers().setSystemTime(new Date('2026-09-03T12:00:00Z'));
    render(<DeviceList devices={[laptop, server]} />);

    const row = screen.getByTestId('portal-device-d-1');
    const online = within(row).getByTestId('portal-device-d-1-last-online');
    expect(online.textContent).toContain('5 minutes ago');
    expect(online.textContent).not.toContain('11:55 AM');
    expect(online.getAttribute('title')).toBe('Sep 3, 2026, 11:55 AM UTC');

    expect(
      within(screen.getByTestId('portal-device-d-2')).getByTestId(
        'portal-device-d-2-last-online'
      ).textContent
    ).toContain('Not known');
  });

  it('speaks the reader’s words for the platform', () => {
    render(<DeviceList devices={[laptop, server]} />);

    expect(screen.getByTestId('portal-device-d-1').textContent).toContain('Mac');
    expect(screen.getByTestId('portal-device-d-1').textContent).not.toContain('macos');
    expect(screen.getByTestId('portal-device-d-2').textContent).toContain('Windows');
    expect(screen.getByTestId('portal-device-d-2').textContent).toContain('Not protected');
  });

  it('demotes the technician facts into a per-row disclosure', () => {
    render(<DeviceList devices={[laptop]} />);

    // Every demoted fact lives inside the disclosure, never loose in the row.
    const more = screen.getByTestId('portal-device-d-1-more');
    for (const demoted of ['Last patch', 'Encryption', 'Last backup', 'Warranty ends']) {
      expect(screen.getByText(demoted).closest('details')).toBe(more);
    }

    expect(more.tagName).toBe('DETAILS');
    expect(within(more).getByText('More about this device')).toBeTruthy();
    expect(more.textContent).toContain('Last patch');
    expect(more.textContent).toContain('Encryption');
    expect(more.textContent).toContain('Encrypted');
    expect(more.textContent).toContain('Last backup');
    expect(more.textContent).toContain('Warranty ends');
    // A warranty end is a future date: it is never relative time.
    expect(more.textContent).toContain('Jan 1, 2027');
  });

  it('reflows every card the same way on a phone', () => {
    render(<DeviceList devices={[laptop, server]} />);

    const signature = (id: string) =>
      Array.from(screen.getByTestId(id).querySelectorAll('td')).map(
        (cell) => cell.className.match(/order-\d+/)?.[0]
      );

    expect(signature('portal-device-d-1')).toEqual([
      'order-1',
      'order-3',
      'order-2',
      'order-4',
      'order-5',
    ]);
    expect(signature('portal-device-d-2')).toEqual(signature('portal-device-d-1'));
  });

  it('carries one status mark per row and the register foot line', () => {
    render(<DeviceList devices={[laptop, server]} />);

    expect(
      screen.getByTestId('portal-device-d-1').querySelectorAll('[aria-hidden="true"].rounded-full')
    ).toHaveLength(1);
    expect(screen.getByTestId('device-ledger-foot').textContent).toBe('1 of 2 online');
  });

  it('totals an all-online fleet in the foot line and exports same-origin', () => {
    render(<DeviceList devices={[laptop]} />);

    expect(screen.getByTestId('device-ledger-foot').textContent).toBe('Your device is online');
    expect(screen.getByTestId('portal-devices-export').getAttribute('href')).toBe(
      '/api/v1/portal/devices/export.csv'
    );
  });

  it('renders an error notice instead of a ledger', () => {
    render(<DeviceList devices={[]} error="Devices are unavailable." />);
    expect(screen.getByRole('alert').textContent).toContain('Devices are unavailable.');
  });
});
