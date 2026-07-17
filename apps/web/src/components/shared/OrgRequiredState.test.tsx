import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../../lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OrgRequiredState } from './OrgRequiredState';

const { applyOrgSwitchMock, mockStoreRef } = vi.hoisted(() => ({
  applyOrgSwitchMock: vi.fn().mockResolvedValue(undefined),
  mockStoreRef: { current: { organizations: [] as Array<{ id: string; name: string }> } },
}));

vi.mock('@/lib/orgSwitch', () => ({
  applyOrgSwitch: applyOrgSwitchMock,
}));

vi.mock('@/stores/orgStore', () => ({
  useOrgStore: (selector: (s: { organizations: Array<{ id: string; name: string }> }) => unknown) =>
    selector(mockStoreRef.current),
}));

function orgs(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `org-${i}`, name: `Org ${i}` }));
}

describe('OrgRequiredState', () => {
  beforeEach(() => {
    applyOrgSwitchMock.mockClear();
    mockStoreRef.current = { organizations: orgs(3) };
  });

  it('renders the shared title and a page-specific description', () => {
    render(<OrgRequiredState description="Network monitoring is per-organization." />);
    expect(screen.getByTestId('org-required-state')).toBeInTheDocument();
    expect(screen.getByText('Select an organization')).toBeInTheDocument();
    expect(screen.getByText('Network monitoring is per-organization.')).toBeInTheDocument();
  });

  it('falls back to the shared description when none is given', () => {
    render(<OrgRequiredState />);
    expect(screen.getByText('This page shows one organization at a time.')).toBeInTheDocument();
  });

  it('quick-picks an org via the shared switch ritual', async () => {
    render(<OrgRequiredState />);
    fireEvent.click(screen.getByText('Org 1'));
    await waitFor(() => expect(applyOrgSwitchMock).toHaveBeenCalledTimes(1));
    expect(applyOrgSwitchMock.mock.calls[0][0]).toBe('org-1');
  });

  it('caps the quick-pick and points long lists at the header switcher', () => {
    mockStoreRef.current = { organizations: orgs(10) };
    render(<OrgRequiredState />);
    expect(screen.getByText('Org 5')).toBeInTheDocument();
    expect(screen.queryByText('Org 6')).toBeNull();
    expect(screen.getByText(/switcher above/)).toBeInTheDocument();
  });
});
