// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_STATUSES } from '@breeze/shared';

// The full API module pulls in Astro's virtual transitions module, which is
// unavailable under Vitest; AssetList only needs the Asset type from it.
vi.mock('@/lib/api', () => ({}));

import { AssetList } from './AssetList';
import type { Asset } from '@/lib/api';

function asset(status: string, i = 0): Asset {
  return {
    id: `a-${i}`,
    hostname: `host-${i}`,
    displayName: `Laptop ${i}`,
    osType: 'windows',
    status: status as Asset['status'],
    lastSeenAt: null,
  };
}

describe('AssetList', () => {
  // #9773: statusMark() returned undefined for anything but online/offline/
  // warning, and the row then read `mark.tone` — the server render threw.
  it.each(DEVICE_STATUSES)('server-renders a %s device without throwing', (status) => {
    expect(() => renderToString(<AssetList assets={[asset(status)]} />)).not.toThrow();
  });

  it('labels every status for the customer instead of printing the enum', () => {
    render(<AssetList assets={DEVICE_STATUSES.map((s, i) => asset(s, i))} />);
    expect(screen.getByText('In maintenance')).toBeTruthy();
    expect(screen.getByText('Quarantined by IT')).toBeTruthy();
    expect(screen.getByText('Retired')).toBeTruthy();
    for (const raw of ['maintenance', 'quarantined', 'decommissioned', 'updating', 'pending']) {
      expect(screen.queryByText(raw)).toBeNull();
    }
  });

  it('renders an unrecognised status as "Not known"', () => {
    // A seen device, so "Not known" can only come from the status cell.
    render(<AssetList assets={[{ ...asset('brand-new-status'), lastSeenAt: new Date().toISOString() }]} />);
    expect(screen.queryByText('brand-new-status')).toBeNull();
    expect(screen.getByText('Not known')).toBeTruthy();
  });
});
