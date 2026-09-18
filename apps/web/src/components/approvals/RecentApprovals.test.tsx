/**
 * #6022 — terminal intents finally have a UI home.
 *
 * `/approvals` listed pending rows only, so the #5934 guardrail refusal that
 * followed an approval (`status=failed`, `error_code=tool_returned_error`) was
 * invisible everywhere: the chat said "Approved · running" and the inbox
 * showed nothing at all.
 */
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));

// Assert on KEYS, not translations — this is a behaviour test, not a locale
// test (the locale files have their own parity coverage).
// The status label falls back to the raw status for any value the locale
// files do not know, so the mock resolves a key to itself and exposes the
// defaultValue path separately.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) =>
      key.startsWith('recent.status.') && opts?.defaultValue === 'nonesuch'
        ? opts.defaultValue
        : key,
  }),
}));

vi.mock('@/lib/utils', () => ({ formatRelativeTime: () => '2 minutes ago' }));

import RecentApprovals from './RecentApprovals';

const refusal =
  'Arming autoInstall requires a human operator with devices.execute and MFA; the AI agent cannot arm software installation.';

function jsonOk(approvals: unknown[]) {
  return { ok: true, status: 200, json: async () => ({ approvals }) };
}

const failedRow = {
  id: 'appr-1',
  actionLabel: 'Enable auto-install on Acme baseline policy',
  actionToolName: 'manage_software_policies',
  orgName: 'Acme Dental',
  decidedAt: '2026-09-16T10:00:00.000Z',
  createdAt: '2026-09-16T09:59:00.000Z',
  intentOutcome: {
    status: 'failed',
    errorCode: 'tool_returned_error',
    reason: refusal,
    executedAt: '2026-09-16T10:00:01.000Z',
  },
};

describe('RecentApprovals (#6022)', () => {
  beforeEach(() => {
    fetchWithAuth.mockReset();
  });

  it('does not fetch until the panel is opened — pending stays first and free', () => {
    render(<RecentApprovals />);
    expect(fetchWithAuth).not.toHaveBeenCalled();
    expect(screen.queryByTestId('approvals-recent-row-appr-1')).toBeNull();
  });

  it('shows a failed intent with its status and the platform\'s own reason', async () => {
    fetchWithAuth.mockResolvedValue(jsonOk([failedRow]));
    render(<RecentApprovals />);

    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-appr-1')).toBeTruthy());
    expect(screen.getByTestId('approvals-recent-status-appr-1').textContent).toBe('recent.status.failed');
    expect(screen.getByTestId('approvals-recent-reason-appr-1').textContent).toContain(
      'cannot arm software installation',
    );
  });

  it('asks the API for the terminal view, not the pending one', async () => {
    fetchWithAuth.mockResolvedValue(jsonOk([]));
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
    expect(String(fetchWithAuth.mock.calls[0][0])).toContain('view=recent');
  });

  it('renders rejected / expired / cancelled as failures too', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonOk([
        { ...failedRow, id: 'r', intentOutcome: { status: 'rejected', errorCode: null, reason: 'the approval was rejected, so it did not run', executedAt: null } },
        { ...failedRow, id: 'e', intentOutcome: { status: 'expired', errorCode: null, reason: 'the approval expired, so it did not run', executedAt: null } },
        { ...failedRow, id: 'c', intentOutcome: { status: 'cancelled', errorCode: null, reason: 'the action was cancelled, so it did not run', executedAt: null } },
      ]),
    );
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-r')).toBeTruthy());
    for (const id of ['r', 'e', 'c']) {
      expect(screen.getByTestId(`approvals-recent-reason-${id}`).textContent).toMatch(/did not run/);
    }
  });

  it('shows a completed intent without a failure reason', async () => {
    fetchWithAuth.mockResolvedValue(
      jsonOk([
        { ...failedRow, id: 'ok', intentOutcome: { status: 'completed', errorCode: null, reason: null, executedAt: null } },
      ]),
    );
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-ok')).toBeTruthy());
    expect(screen.getByTestId('approvals-recent-status-ok').textContent).toBe('recent.status.completed');
    expect(screen.queryByTestId('approvals-recent-reason-ok')).toBeNull();
  });

  it('falls back to the raw status for a value the locale files do not know', async () => {
    // A ninth intent status must render as itself, not as a blank chip.
    fetchWithAuth.mockResolvedValue(
      jsonOk([
        { ...failedRow, id: 'x', intentOutcome: { status: 'nonesuch', errorCode: null, reason: null, executedAt: null } },
      ]),
    );
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-x')).toBeTruthy());
    expect(screen.getByTestId('approvals-recent-status-x').textContent).toBe('nonesuch');
  });

  it('renders a denied unlinked (PAM) row as a failure, not a green check', async () => {
    // The server derives an outcome from the approval's own status for rows
    // with no linked intent. If it ever stops, the next test is the backstop.
    fetchWithAuth.mockResolvedValue(
      jsonOk([
        {
          ...failedRow,
          id: 'pam',
          intentOutcome: { status: 'denied', errorCode: null, reason: 'Not during change freeze', executedAt: null },
        },
      ]),
    );
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-pam')).toBeTruthy());
    expect(screen.getByTestId('approvals-recent-row-pam').querySelector('[data-outcome]')?.getAttribute('data-outcome')).toBe('failure');
    expect(screen.getByTestId('approvals-recent-reason-pam').textContent).toContain('change freeze');
  });

  it('never paints an UNKNOWN outcome green — "we don\'t know" is not "it worked"', async () => {
    // A missing projection or a status the client does not recognise must not
    // fall into the success branch; that is #6022 pointing the other way.
    fetchWithAuth.mockResolvedValue(
      jsonOk([
        { ...failedRow, id: 'none', intentOutcome: null },
        { ...failedRow, id: 'new', intentOutcome: { status: 'some_future_status', errorCode: null, reason: null, executedAt: null } },
      ]),
    );
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-row-none')).toBeTruthy());
    for (const id of ['none', 'new']) {
      const kind = screen
        .getByTestId(`approvals-recent-row-${id}`)
        .querySelector('[data-outcome]')
        ?.getAttribute('data-outcome');
      expect(kind).toBe('unknown');
      expect(kind).not.toBe('success');
    }
  });

  it('surfaces a load failure inline instead of rendering a silently empty panel', async () => {
    fetchWithAuth.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-error')).toBeTruthy());
    expect(screen.queryByTestId('approvals-recent-empty')).toBeNull();
  });

  it('distinguishes "nothing finished" from a failed load', async () => {
    fetchWithAuth.mockResolvedValue(jsonOk([]));
    render(<RecentApprovals />);
    fireEvent.click(screen.getByTestId('approvals-recent-toggle'));

    await waitFor(() => expect(screen.getByTestId('approvals-recent-empty')).toBeTruthy());
    expect(screen.queryByTestId('approvals-recent-error')).toBeNull();
  });
});
