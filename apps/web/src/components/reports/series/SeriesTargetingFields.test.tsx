import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ORGS = vi.hoisted(() => [
  { id: 'o-1', partnerId: 'p', name: 'Acme Dental', status: 'active', createdAt: '' },
  { id: 'o-2', partnerId: 'p', name: 'Birch Law', status: 'trial', createdAt: '' },
  { id: 'o-3', partnerId: 'p', name: 'Cedar Ltd', status: 'suspended', createdAt: '' },
]);
vi.mock('../../../stores/orgStore', () => ({ useOrgStore: () => ({ organizations: ORGS, currentOrgId: null }) }));

import { SeriesTargetingFields } from './SeriesTargetingFields';

describe('SeriesTargetingFields', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only eligible orgs; in All mode unticking adds an exclusion', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: [] }} onChange={onChange} />);
    expect(screen.queryByTestId('series-target-org-o-3')).toBeNull();
    expect(screen.getByTestId('series-target-org-o-1')).toBeChecked();
    expect(screen.getByTestId('series-target-summary')).toHaveTextContent('Covers 2 of 2 organizations');
    fireEvent.click(screen.getByTestId('series-target-org-o-1'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'all', orgIds: ['o-1'] });
  });

  it('in Chosen mode ticking adds an inclusion and nothing chosen is flagged', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'selected', orgIds: [] }} onChange={onChange} />);
    expect(screen.getByTestId('series-target-none-selected')).toBeInTheDocument();
    expect(screen.getByTestId('series-target-org-o-2')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('series-target-org-o-2'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'selected', orgIds: ['o-2'] });
  });

  // Review Focus 3: an exclusion list must never become an inclusion list.
  it('switching the mode clears the org list', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: ['o-2'] }} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('series-target-mode-selected'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'selected', orgIds: [] });
  });

  it('filters by search and keeps ids it cannot show', () => {
    const onChange = vi.fn();
    render(<SeriesTargetingFields value={{ targetMode: 'all', orgIds: ['o-3'] }} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('series-target-search'), { target: { value: 'birch' } });
    expect(screen.queryByTestId('series-target-org-o-1')).toBeNull();
    fireEvent.click(screen.getByTestId('series-target-org-o-2'));
    expect(onChange).toHaveBeenCalledWith({ targetMode: 'all', orgIds: ['o-3', 'o-2'] });
  });
});
