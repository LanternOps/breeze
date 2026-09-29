import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fetchWithAuth = vi.fn();
vi.mock('../../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
vi.mock('../../shared/Toast', () => ({ showToast: vi.fn() }));

import { showToast } from '../../shared/Toast';
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
          stalled: true,
          contactRecipients: [{ contactId: 'c-1', name: 'Ann', email: 'ann@acme.test' }], emailRecipients: ['cc@msp.test', 'extra@msp.test'] },
        { reportId: 'rep-a2', name: 'Weekly alerts (old)', lastGeneratedAt: null, action: 'archive', deliverableLinked: false,
          stalled: false, contactRecipients: [], emailRecipients: ['cc@msp.test'] },
      ],
    },
    {
      orgId: 'org-b', orgName: 'Bravo',
      rows: [{ reportId: 'rep-b1', name: 'Weekly alerts', lastGeneratedAt: null, action: 'adopt', deliverableLinked: false,
        stalled: false, contactRecipients: [], emailRecipients: ['cc@msp.test'] }],
    },
  ],
  sharedCc: ['cc@msp.test'],
  conflictingCc: [{ email: 'extra@msp.test', reportIds: ['rep-a1'] }],
  planFingerprint: 'f'.repeat(64),
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
      planFingerprint: group.planFingerprint,
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

  // W04 final review F1c: a row that is not sending today is marked; combining resumes it.
  it('marks a stalled row, and only that row', () => {
    renderDialog();
    expect(screen.getByTestId('combine-row-rep-a1-stalled')).toHaveTextContent('Not sending today');
    expect(screen.queryByTestId('combine-row-rep-a2-stalled')).toBeNull();
    expect(screen.queryByTestId('combine-row-rep-b1-stalled')).toBeNull();
  });

  // W04 final review F4: the CC decision shows who receives the address today.
  it('lists where each conflicting CC address is today', () => {
    renderDialog();
    expect(screen.getByTestId('combine-cc-extra@msp.test-held-by')).toHaveTextContent('Currently CC\'d on: Acme — Weekly alerts');
  });

  // W04 final review F5: no raw error tokens; the blocked orgs are named.
  it('names the blocked organizations on series_owner_ineligible', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ error: 'series_owner_ineligible', orgIds: ['org-b', 'org-elsewhere'] }, 400));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    const { message } = vi.mocked(showToast).mock.calls.at(-1)![0] as { message: string };
    expect(message).toContain('Bravo');
    expect(message).toContain('other organizations');
    expect(message).not.toContain('series_owner_ineligible');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('explains combine_cc_too_many with the limit, and maps W03 series codes', async () => {
    fetchWithAuth.mockReturnValueOnce(okResponse({ error: 'combine_cc_too_many', max: 50 }, 400));
    renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(1));
    expect((vi.mocked(showToast).mock.calls[0]![0] as { message: string }).message).toBe('Too many internal CC addresses (max 50).');

    fetchWithAuth.mockReturnValueOnce(okResponse({ error: 'series_type_unsupported' }, 400));
    await waitFor(() => expect(screen.getByTestId('combine-confirm')).toBeEnabled());
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(showToast).toHaveBeenCalledTimes(2));
    const second = (vi.mocked(showToast).mock.calls[1]![0] as { message: string }).message;
    expect(second).not.toContain('series_type_unsupported');
    expect(second.length).toBeGreaterThan(0);
  });

  it('refreshes the parent when the group changed underneath the dialog', async () => {
    fetchWithAuth.mockReturnValue(okResponse({ error: 'combine_group_changed' }, 409));
    const onChanged = renderDialog();
    fireEvent.click(screen.getByTestId('combine-cc-drop-extra@msp.test'));
    fireEvent.click(screen.getByTestId('combine-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
});
