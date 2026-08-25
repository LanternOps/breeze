import '@/lib/i18n';

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FilterPreviewResult } from '@breeze/shared';

import { FilterPreview } from './FilterPreview';

const decommissionedDevice = {
  id: 'device-1',
  hostname: 'edge-01',
  displayName: null,
  osType: 'windows',
  status: 'decommissioned',
  lastSeenAt: null
};

const preview: FilterPreviewResult = {
  totalCount: 1,
  devices: [decommissionedDevice],
  evaluatedAt: new Date('2026-08-24T00:00:00.000Z')
};

// #3987 fix wave 2: StatusIndicator/StatusBadge changed the decommissioned
// colour from red to grey AND resolve the label through an i18n override
// (filters.value.enumOverrides.decommissioned), but nothing rendered a
// decommissioned status through this component before now.
describe('FilterPreview decommissioned status rendering', () => {
  it('renders the label "Removed" (not the raw enum) and carries muted classes', () => {
    render(
      <FilterPreview preview={preview} loading={false} error={null} onRefresh={vi.fn()} />
    );

    // StatusBadge text.
    const badge = screen.getByText('Removed');
    expect(badge).toBeInTheDocument();
    expect(screen.queryByText('decommissioned')).not.toBeInTheDocument();

    // Muted grey classes, not the destructive/red palette.
    expect(badge.className).toContain('bg-gray-100');
    expect(badge.className).toContain('text-gray-700');
    expect(badge.className).not.toContain('red');
    expect(badge.className).not.toContain('destructive');

    // StatusIndicator dot: title carries the same "Removed" label, and its
    // color is the muted grey shared with offline, not a red/error color.
    const dot = document.querySelector('[title="Removed"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-gray-400');
    expect(dot!.className).not.toContain('red');
  });
});
