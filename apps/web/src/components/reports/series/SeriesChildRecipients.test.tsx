import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchOrgContacts: vi.fn(),
  fetchChildOverrides: vi.fn(),
  setChildRecipientOverride: vi.fn(() => Promise.resolve()),
}));
vi.mock('./seriesApi', () => api);

import { SeriesChildRecipients } from './SeriesChildRecipients';

const CONTACTS = [
  { id: 'c-1', name: 'Pat Primary', email: 'pat@example.com', roles: [], isPrimary: true, siteId: null },
  { id: 'c-2', name: 'Bill Billing', email: 'bill@example.com', roles: ['billing'], isPrimary: false, siteId: null },
];

describe('SeriesChildRecipients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchOrgContacts.mockResolvedValue(CONTACTS);
    api.fetchChildOverrides.mockResolvedValue([{ contactId: 'c-2', mode: 'add' }]);
  });

  it('shows each contact\'s override and who the rule already includes', async () => {
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={{ primaryContact: true, roles: [] }} />);
    expect(await screen.findByTestId('series-child-recipient-c-1')).toHaveValue('default');
    expect(screen.getByTestId('series-child-recipient-c-2')).toHaveValue('add');
    expect(screen.getByTestId('series-child-by-rule-c-1')).toHaveTextContent('Included by rule');
    expect(screen.queryByTestId('series-child-by-rule-c-2')).toBeNull();
    expect(api.fetchOrgContacts).toHaveBeenCalledWith('org-1');
  });

  it('writes an override and keeps the new choice', async () => {
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={null} />);
    const select = await screen.findByTestId('series-child-recipient-c-1');
    fireEvent.change(select, { target: { value: 'remove' } });
    await waitFor(() => expect(api.setChildRecipientOverride).toHaveBeenCalledWith('rep-1', 'c-1', 'default', 'remove', expect.anything()));
    await waitFor(() => expect(screen.getByTestId('series-child-recipient-c-1')).toHaveValue('remove'));
  });

  it('reloads the truth when a write fails', async () => {
    api.setChildRecipientOverride.mockRejectedValueOnce(new Error('network'));
    render(<SeriesChildRecipients reportId="rep-1" orgId="org-1" rule={null} />);
    fireEvent.change(await screen.findByTestId('series-child-recipient-c-2'), { target: { value: 'remove' } });
    await waitFor(() => expect(api.fetchChildOverrides).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('series-child-recipient-c-2')).toHaveValue('add');
  });
});
