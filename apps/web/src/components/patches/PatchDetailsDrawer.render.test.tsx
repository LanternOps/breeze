import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import PatchDetailsDrawer from './PatchDetailsDrawer';
import type { Patch } from './PatchList';
import type { UpdateRingItem } from './UpdateRingList';

const patch = (o: Partial<Patch> = {}): Patch => ({
  id: 'p', title: 't', severity: 'critical', source: 'microsoft', os: 'windows',
  releaseDate: '2026-10-14', approvalStatus: 'pending', ...o,
});
const ring = {
  id: 'r', name: 'R', enabled: true, ringOrder: 0, deferralDays: 0, gracePeriodHours: 0,
  autoApprove: { enabled: true, severities: ['critical'], deferralDays: 7 },
} as UpdateRingItem;

describe('PatchDetailsDrawer', () => {
  it('renders a bare YYYY-MM-DD release date on the same calendar day (west of UTC)', () => {
    // Meaningful only under TZ=America/Denver (set by the test run command).
    render(<PatchDetailsDrawer patch={patch()} rings={[ring]} onClose={() => {}} />);
    expect(screen.getByTestId('patch-details-release').textContent)
      .toContain(new Date(2026, 9, 14).toLocaleDateString());
    // 10/14 + 7d deferral = 10/21
    expect(document.body.textContent).toContain(new Date(2026, 9, 21).toLocaleDateString());
  });

  it('falls back to externalId when packageId is null', () => {
    render(<PatchDetailsDrawer patch={patch({ packageId: null, externalId: 'KB5044284' })} rings={[]} onClose={() => {}} />);
    expect(screen.getByTestId('patch-details-package-id').textContent).toContain('KB5044284');
  });
});
