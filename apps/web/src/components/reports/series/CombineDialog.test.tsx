import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import CombineDialog from './CombineDialog';
import type { CombineCandidateGroup } from './types';

const group: CombineCandidateGroup = {
  groupKey: 'a'.repeat(64),
  type: 'alert_summary',
  format: 'pdf',
  schedule: 'weekly',
  suggestedName: 'Weekly alerts',
  orgs: [
    {
      orgId: 'org-a', orgName: 'Acme',
      rows: [
        { reportId: 'rep-a1', name: 'Weekly alerts', lastGeneratedAt: '2026-09-20T08:00:00.000Z', action: 'adopt', deliverableLinked: true,
          contactRecipients: [{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }], emailRecipients: ['cc@msp.test', 'extra@msp.test'] },
        { reportId: 'rep-a2', name: 'Weekly alerts (old)', lastGeneratedAt: null, action: 'archive', deliverableLinked: false,
          contactRecipients: [], emailRecipients: ['cc@msp.test'] },
      ],
    },
    {
      orgId: 'org-b', orgName: 'Bravo',
      rows: [{ reportId: 'rep-b1', name: 'Weekly alerts', lastGeneratedAt: null, action: 'adopt', deliverableLinked: false,
        contactRecipients: [], emailRecipients: ['cc@msp.test'] }],
    },
  ],
  sharedCc: ['cc@msp.test'],
  conflictingCc: [{ email: 'extra@msp.test', reportIds: ['rep-a1'] }],
};

function renderDialog(onChanged = vi.fn()) {
  render(<CombineDialog open groups={[group]} timezone="UTC" onClose={vi.fn()} onChanged={onChanged} />);
  return onChanged;
}

const okResponse = (body: unknown, status = 201) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

describe('CombineDialog (series W04)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each org with the row kept and the duplicate archived; confirm waits for every CC decision', () => {
    renderDialog();
    expect(screen.getByTestId('combine-row-rep-a1')).toHaveAttribute('data-action', 'adopt');
    expect(screen.getByTestId('combine-row-rep-a2')).toHaveAttribute('data-action', 'archive');
    expect(screen.getByTestId('combine-row-rep-a1-deliverable')).toBeInTheDocument();
    expect(screen.getByTestId('combine-cc-shared')).toHaveTextContent('cc@msp.test');
    expect(screen.getByTestId('combine-name')).toHaveValue('Weekly alerts');
    expect(screen.getByTestId('combine-target-selected')).toBeChecked();
    expect(screen.getByTestId('combine-confirm')).toBeDisabled();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    expect(screen.getByTestId('combine-confirm')).toBeEnabled();
  });

  it('posts exactly the group it showed, with the CC decisions', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ seriesId: 's-1', adopted: [], archived: [], repointedDeliverableIds: [] }));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-include-extra@msp.test'));
    fireEvent.change(screen.getByTestId('combine-name'), { target: { value: '  Weekly critical alerts ' } });
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    const [url, init] = fetchWithAuth.mock.calls[0]!;
    expect(url).toBe('/reports/series/combine');
    expect(init).toMatchObject({ method: 'POST', skipOrgIdInjection: true });
    expect(JSON.parse(init.body)).toEqual({
      groupKey: group.groupKey,
      reportIds: ['rep-a1', 'rep-a2', 'rep-b1'],
      name: 'Weekly critical alerts',
      targetMode: 'selected',
      ccResolution: { include: ['extra@msp.test'], drop: [] },
    });
  });

  it('warns before switching to all organizations', () => {
    renderDialog();
    expect(screen.queryByTestId('combine-target-all-warning')).toBeNull();
    fireEvent.click(screen.getByTestId('combine-target-all'));
    expect(screen.getByTestId('combine-target-all-warning')).toBeInTheDocument();
  });

  it('marks the addresses the server still considers unresolved and stays open', async () => {
    fetchWithAuth.mockReturnValue(okResponse({
      error: 'combine_cc_conflict', shared: ['cc@msp.test'], unresolved: [{ email: 'extra@msp.test', reportIds: ['rep-a1'] }], unexpected: [],
    }, 409));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(screen.getByTestId('combine-cc-extra@msp.test')).toHaveAttribute('data-server-unresolved', 'true'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('refreshes the parent when the group changed underneath the dialog', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ error: 'combine_group_changed' }, 409));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
