import '@/lib/i18n';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { fetchMock, toastMock, capability } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  toastMock: vi.fn(),
  capability: { canReattach: true },
}));

vi.mock('../../stores/auth', () => ({ fetchWithAuth: fetchMock }));
vi.mock('../shared/Toast', () => ({ showToast: toastMock }));
vi.mock('@/lib/navigation', () => ({ navigateTo: vi.fn() }));
vi.mock('../../services/deviceActions', () => ({
  fetchRemovalConfig: vi.fn(async () => ({ uninstallDrainWindowHours: 72 })),
}));
vi.mock('../../lib/reattachCapability', () => ({ useCanReattachDevice: () => capability.canReattach }));
vi.mock('../../lib/mfaStepUp', () => ({
  mintStepUpGrant: vi.fn(),
  StepUpMintError: class StepUpMintError extends Error {},
}));

import PossibleReplacementBanner from './PossibleReplacementBanner';
import type { ReinstallCandidatesView } from '../../lib/deviceReattach';
import {
  SOURCE_ID,
  TARGET_ID,
  candidatesView,
  json,
  reattachCandidate,
  requestedIntent,
} from './__tests__/reattachFixtures';

/** Routes the banner's reads by URL; `reattach` answers the POST. */
function routeFetch(opts: {
  views: ReinstallCandidatesView[] | 'refused';
  reattach?: Response;
}) {
  let viewCall = 0;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === `/devices/${TARGET_ID}`) {
      return json(200, { id: TARGET_ID, hostname: 'LAPTOP-OLD', displayName: null, status: 'offline' });
    }
    if (url === `/devices/${SOURCE_ID}/reinstall-candidates`) {
      if (opts.views === 'refused') return json(404, { error: 'Device not found' });
      const view = opts.views[Math.min(viewCall, opts.views.length - 1)]!;
      viewCall += 1;
      return json(200, view);
    }
    if (url === `/devices/${SOURCE_ID}/reattach` && init?.method === 'POST') {
      return opts.reattach ?? json(500, { error: 'unexpected' });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function renderBanner(sourceOrgId = 'org-a') {
  render(
    <PossibleReplacementBanner
      possibleReplacementOfDeviceId={TARGET_ID}
      sourceDeviceId={SOURCE_ID}
      sourceOrgId={sourceOrgId}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  capability.canReattach = true;
});

const candidateReads = () => fetchMock.mock.calls.filter(([url]) => url === `/devices/${SOURCE_ID}/reinstall-candidates`).length;

describe('PossibleReplacementBanner reattach (#8318)', () => {
  it('offers Reattach for a same-org candidate and requests it through the dialog', async () => {
    const user = userEvent.setup();
    const pendingView = candidatesView({
      openIntent: { intentId: 'intent-1', state: 'requested', targetDeviceId: TARGET_ID, expiresAt: requestedIntent.expiresAt },
    });
    routeFetch({ views: [candidatesView(), pendingView], reattach: json(202, { intent: requestedIntent }) });
    renderBanner();

    await user.click(await screen.findByTestId('possible-replacement-reattach'));
    expect(screen.getByTestId('reattach-dialog')).toBeTruthy();
    await user.click(screen.getByTestId('reattach-possession'));
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    await user.click(screen.getByTestId('reattach-submit'));

    // Pending inside the dialog, and the banner re-reads: the action gives way
    // to the pending note.
    await waitFor(() => expect(screen.getByTestId('reattach-pending')).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId('possible-replacement-reattach-pending')).toBeTruthy());
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
    await user.click(screen.getByTestId('reattach-done'));
    expect(screen.queryByTestId('reattach-dialog')).toBeNull();
  });

  it('offers nothing for a candidate in another org (the banner covers the same-org case)', async () => {
    routeFetch({ views: [candidatesView({ candidates: [reattachCandidate({ orgId: 'org-b' })] })] });
    renderBanner();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(`/devices/${SOURCE_ID}/reinstall-candidates`));
    await screen.findByTestId('possible-replacement-decommission');
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
  });

  it('tells a viewer who is not shown the candidate that a review is pending', async () => {
    routeFetch({ views: [candidatesView({ candidates: [], reviewPending: true })] });
    renderBanner();
    expect((await screen.findByTestId('possible-replacement-review-pending')).textContent)
      .toBe('A possible reinstall awaits partner review.');
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
  });

  it('shows an open reattach as pending instead of offering another', async () => {
    routeFetch({
      views: [candidatesView({
        openIntent: { intentId: 'intent-1', state: 'staged', targetDeviceId: TARGET_ID, expiresAt: requestedIntent.expiresAt },
      })],
    });
    renderBanner();
    await screen.findByTestId('possible-replacement-reattach-pending');
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
  });

  it('a refused candidates read leaves the review-and-remove banner as it was', async () => {
    routeFetch({ views: 'refused' });
    renderBanner();
    await screen.findByTestId('possible-replacement-decommission');
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
    expect(screen.queryByTestId('possible-replacement-review-pending')).toBeNull();
  });

  it('a target that changed re-reads, and the form restarts on the new version', async () => {
    const user = userEvent.setup();
    routeFetch({
      views: [candidatesView(), candidatesView({ candidates: [reattachCandidate({ targetVersion: 'w'.repeat(43) })] })],
      reattach: json(409, { error: 'changed', code: 'target_changed' }),
    });
    renderBanner();
    await user.click(await screen.findByTestId('possible-replacement-reattach'));
    await user.click(screen.getByTestId('reattach-possession'));
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    await user.click(screen.getByTestId('reattach-submit'));
    await waitFor(() => expect(candidateReads()).toBe(2));
    // Still open, started over for the current install.
    await waitFor(() => expect((screen.getByTestId('reattach-confirm-name') as HTMLInputElement).value).toBe(''));
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('a removed target recovers without a reload: the re-read brings the restore checkbox', async () => {
    const user = userEvent.setup();
    routeFetch({
      views: [
        candidatesView(),
        candidatesView({ candidates: [reattachCandidate({ status: 'decommissioned', requiresRestore: true })] }),
      ],
      reattach: json(409, { error: 'removed', code: 'target_decommissioned' }),
    });
    renderBanner();
    await user.click(await screen.findByTestId('possible-replacement-reattach'));
    expect(screen.queryByTestId('reattach-restore')).toBeNull();
    await user.click(screen.getByTestId('reattach-possession'));
    await user.type(screen.getByTestId('reattach-confirm-name'), 'LAPTOP-OLD');
    await user.click(screen.getByTestId('reattach-submit'));
    await waitFor(() => expect(screen.getByTestId('reattach-restore')).toBeTruthy());
    expect(candidateReads()).toBe(2);
    expect((screen.getByTestId('reattach-submit') as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByTestId('reattach-restore'));
    expect((screen.getByTestId('reattach-submit') as HTMLButtonElement).disabled).toBe(false);
  });

  it('closing the dialog re-reads the candidates', async () => {
    const user = userEvent.setup();
    routeFetch({ views: [candidatesView()] });
    renderBanner();
    await user.click(await screen.findByTestId('possible-replacement-reattach'));
    await user.click(screen.getByTestId('reattach-cancel'));
    await waitFor(() => expect(candidateReads()).toBe(2));
  });

  it('a pending reattach onto another record is worded neutrally and still hides Reattach', async () => {
    routeFetch({
      views: [candidatesView({
        openIntent: {
          intentId: 'intent-1', state: 'requested',
          targetDeviceId: '99999999-9999-4999-8999-999999999999', expiresAt: requestedIntent.expiresAt,
        },
      })],
    });
    renderBanner();
    const note = await screen.findByTestId('possible-replacement-reattach-pending');
    expect(note.textContent).toMatch(/^A reattach of this device is pending\./);
    expect(note.textContent).not.toMatch(/old record/);
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
  });

  it('a pending reattach onto the flagged record names the old record', async () => {
    routeFetch({
      views: [candidatesView({
        openIntent: { intentId: 'intent-1', state: 'requested', targetDeviceId: TARGET_ID, expiresAt: requestedIntent.expiresAt },
      })],
    });
    renderBanner();
    expect((await screen.findByTestId('possible-replacement-reattach-pending')).textContent).toMatch(/old record/);
  });

  it('offers no Reattach to a user without devices:write + devices:delete in partner scope', async () => {
    capability.canReattach = false;
    routeFetch({ views: [candidatesView()] });
    renderBanner();
    await screen.findByTestId('possible-replacement-decommission');
    await waitFor(() => expect(candidateReads()).toBe(1));
    expect(screen.queryByTestId('possible-replacement-reattach')).toBeNull();
  });
});
