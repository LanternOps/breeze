import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  detailActions,
  findingActionSuccessMessage,
  findingDetailMeta,
  findingDetailNotFoundCopy,
  findingDetailReducer,
  initialFindingDetailState,
  isActionBusy,
  memberPrimaryLabel,
  memberSecondaryLabel,
  type FindingDetailData,
  type FindingDetailState,
  type FindingMember,
} from './findingDetail';

function member(overrides: Partial<FindingMember> = {}): FindingMember {
  return {
    deviceId: 'd-1',
    hostname: 'WIN-ACCT-01',
    displayName: 'Reception PC',
    osType: 'windows',
    lastSeenAt: '2026-09-09T12:00:00.000Z',
    ...overrides,
  };
}

function finding(overrides: Partial<FindingDetailData> = {}): FindingDetailData {
  return {
    id: 'f-1',
    orgId: 'o-1',
    orgName: 'Berthoud Vet Care',
    title: 'VSS writers failing',
    summary: 'Shadow copy creation failed on 3 devices.',
    status: 'open',
    severity: 'error',
    deviceCount: 3,
    firstSeenAt: '2026-09-01T12:00:00.000Z',
    lastSeenAt: '2026-09-09T12:00:00.000Z',
    dismissNotes: null,
    members: [member()],
    ...overrides,
  };
}

describe('findingDetailReducer', () => {
  it('starts loading with nothing loaded', () => {
    expect(initialFindingDetailState).toEqual({
      phase: 'loading',
      finding: null,
      refreshing: false,
      pendingAction: null,
      errorMessage: null,
      actionErrorMessage: null,
    });
  });

  it('loads a finding', () => {
    const state = findingDetailReducer(initialFindingDetailState, {
      type: 'loaded',
      finding: finding(),
    });
    expect(state.phase).toBe('ready');
    expect(state.finding?.id).toBe('f-1');
    expect(state.errorMessage).toBeNull();
  });

  it('treats a 404 as its own state so the screen shows an empty state, not a crash', () => {
    const state = findingDetailReducer(initialFindingDetailState, { type: 'notFound' });
    expect(state.phase).toBe('notFound');
    expect(state.finding).toBeNull();
    expect(state.errorMessage).toBeNull();
  });

  it('errors when the fetch fails for any other reason', () => {
    const state = findingDetailReducer(initialFindingDetailState, {
      type: 'failed',
      message: 'Network request failed',
    });
    expect(state.phase).toBe('error');
    expect(state.errorMessage).toBe('Network request failed');
  });

  it('keeps the loaded finding on screen while a reload runs', () => {
    const ready = findingDetailReducer(initialFindingDetailState, {
      type: 'loaded',
      finding: finding(),
    });
    const reloading = findingDetailReducer(ready, { type: 'load' });
    expect(reloading.phase).toBe('ready');
    expect(reloading.refreshing).toBe(true);
    expect(reloading.finding?.id).toBe('f-1');
  });

  it('shows the skeleton on a first load', () => {
    const state = findingDetailReducer(initialFindingDetailState, { type: 'load' });
    expect(state.phase).toBe('loading');
    expect(state.refreshing).toBe(false);
  });

  it('marks the action pending and clears a prior action error', () => {
    const ready: FindingDetailState = {
      ...initialFindingDetailState,
      phase: 'ready',
      finding: finding(),
      actionErrorMessage: 'Previously failed',
    };
    const pending = findingDetailReducer(ready, { type: 'actionStarted', action: 'acknowledge' });
    expect(pending.pendingAction).toBe('acknowledge');
    expect(pending.actionErrorMessage).toBeNull();
    expect(isActionBusy(pending)).toBe(true);
  });

  it('swaps in the server copy of the finding when an action succeeds', () => {
    const pending = findingDetailReducer(
      { ...initialFindingDetailState, phase: 'ready', finding: finding() },
      { type: 'actionStarted', action: 'acknowledge' },
    );
    const done = findingDetailReducer(pending, {
      type: 'actionSucceeded',
      finding: finding({ status: 'acknowledged' }),
    });
    expect(done.finding?.status).toBe('acknowledged');
    expect(done.pendingAction).toBeNull();
    expect(done.actionErrorMessage).toBeNull();
    expect(isActionBusy(done)).toBe(false);
  });

  it('keeps the old finding and reports the failure when an action fails', () => {
    const pending = findingDetailReducer(
      { ...initialFindingDetailState, phase: 'ready', finding: finding() },
      { type: 'actionStarted', action: 'dismiss' },
    );
    const failed = findingDetailReducer(pending, {
      type: 'actionFailed',
      message: 'Notes are required',
    });
    expect(failed.finding?.status).toBe('open');
    expect(failed.pendingAction).toBeNull();
    expect(failed.actionErrorMessage).toBe('Notes are required');
    expect(failed.phase).toBe('ready');
  });

  it('does not turn an action failure into a whole-screen error', () => {
    const pending = findingDetailReducer(
      { ...initialFindingDetailState, phase: 'ready', finding: finding() },
      { type: 'actionStarted', action: 'reopen' },
    );
    const failed = findingDetailReducer(pending, { type: 'actionFailed', message: 'Offline' });
    expect(failed.errorMessage).toBeNull();
  });

  it('recovers to ready after a failed first load succeeds on retry', () => {
    const errored = findingDetailReducer(initialFindingDetailState, {
      type: 'failed',
      message: 'Offline',
    });
    const recovered = findingDetailReducer(errored, { type: 'loaded', finding: finding() });
    expect(recovered.phase).toBe('ready');
    expect(recovered.errorMessage).toBeNull();
  });
});

describe('detailActions', () => {
  it('offers nothing while the finding is still loading', () => {
    expect(detailActions(initialFindingDetailState)).toEqual([]);
  });

  it('derives the buttons from the loaded status', () => {
    const open = { ...initialFindingDetailState, phase: 'ready' as const, finding: finding() };
    expect(detailActions(open)).toEqual(['acknowledge', 'dismiss']);

    const acked = {
      ...open,
      finding: finding({ status: 'acknowledged' }),
    };
    expect(detailActions(acked)).toEqual(['dismiss', 'reopen']);

    const resolved = { ...open, finding: finding({ status: 'resolved' }) };
    expect(detailActions(resolved)).toEqual([]);
  });

  it('keeps offering the buttons while one is running so they can render disabled', () => {
    const pending = findingDetailReducer(
      { ...initialFindingDetailState, phase: 'ready', finding: finding() },
      { type: 'actionStarted', action: 'acknowledge' },
    );
    expect(detailActions(pending)).toEqual(['acknowledge', 'dismiss']);
    expect(isActionBusy(pending)).toBe(true);
  });
});

describe('member copy', () => {
  it('prefers the display name and falls back to the hostname', () => {
    expect(memberPrimaryLabel(member())).toBe('Reception PC');
    expect(memberPrimaryLabel(member({ displayName: null }))).toBe('WIN-ACCT-01');
    expect(memberPrimaryLabel(member({ displayName: '   ' }))).toBe('WIN-ACCT-01');
  });

  it('falls back to the device id when a device has neither name', () => {
    expect(memberPrimaryLabel(member({ displayName: null, hostname: '' }))).toBe('d-1');
  });

  describe('secondary line', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-09-09T14:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('shows the hostname alongside the OS when the display name differs', () => {
      expect(memberSecondaryLabel(member())).toBe('WIN-ACCT-01 · Windows · 2h ago');
    });

    it('does not repeat the hostname when it is already the primary label', () => {
      expect(memberSecondaryLabel(member({ displayName: null }))).toBe('Windows · 2h ago');
    });

    it('drops an unusable last-seen', () => {
      expect(memberSecondaryLabel(member({ displayName: null, lastSeenAt: '' }))).toBe('Windows');
    });
  });
});

describe('findingDetailMeta', () => {
  it('renders an em dash rather than a blank for a missing value', () => {
    const rows = findingDetailMeta(finding({ orgName: null, summary: null }));
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.Organization).toBe('—');
  });

  it('reports status, severity, org, device count and both timestamps', () => {
    const rows = findingDetailMeta(finding());
    expect(rows.map((r) => r.label)).toEqual([
      'Status',
      'Severity',
      'Organization',
      'Devices',
      'First seen',
      'Last seen',
    ]);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
    expect(byLabel.Status).toBe('Open');
    expect(byLabel.Severity).toBe('Error');
    expect(byLabel.Organization).toBe('Berthoud Vet Care');
    expect(byLabel.Devices).toBe('3');
  });

  it('adds the dismiss note only when the finding carries one', () => {
    expect(findingDetailMeta(finding()).some((r) => r.label === 'Dismiss note')).toBe(false);
    const dismissed = findingDetailMeta(
      finding({ status: 'dismissed', dismissNotes: 'Known and accepted' }),
    );
    expect(dismissed.at(-1)).toEqual({ label: 'Dismiss note', value: 'Known and accepted' });
  });
});

describe('outcome copy', () => {
  it('confirms each action in plain words', () => {
    expect(findingActionSuccessMessage('acknowledge')).toBe('Finding acknowledged.');
    expect(findingActionSuccessMessage('dismiss')).toBe('Finding dismissed.');
    expect(findingActionSuccessMessage('reopen')).toBe('Finding reopened.');
  });

  it('explains a missing finding instead of showing a blank screen', () => {
    expect(findingDetailNotFoundCopy()).toEqual({
      title: 'Finding not available',
      body: 'This finding was resolved or is no longer visible to your account.',
    });
  });
});

describe('actionSettled — the action landed but the re-read did not', () => {
  const loaded: FindingDetailState = {
    ...initialFindingDetailState,
    phase: 'ready',
    finding: finding({ status: 'open', members: [member()] }),
    pendingAction: 'acknowledge',
  };

  it('folds the PATCH row in and keeps the members already on screen', () => {
    const next = findingDetailReducer(loaded, {
      type: 'actionSettled',
      row: {
        ...finding(),
        status: 'acknowledged',
      },
    });
    expect(next.phase).toBe('ready');
    expect(next.finding?.status).toBe('acknowledged');
    // A lifecycle action does not change membership, so the list we already
    // hold is still the truth — dropping it would blank the device list on a
    // refresh blip.
    expect(next.finding?.members).toEqual([member()]);
  });

  it('clears the pending action so the buttons come back enabled', () => {
    const next = findingDetailReducer(loaded, {
      type: 'actionSettled',
      row: { ...finding(), status: 'acknowledged' },
    });
    expect(next.pendingAction).toBeNull();
    expect(isActionBusy(next)).toBe(false);
  });

  it('does not report the action as failed', () => {
    const next = findingDetailReducer(loaded, {
      type: 'actionSettled',
      row: { ...finding(), status: 'acknowledged' },
    });
    expect(next.actionErrorMessage).toBeNull();
  });

  it('is a no-op on pendingAction alone when nothing is on screen to merge into', () => {
    const next = findingDetailReducer(
      { ...initialFindingDetailState, pendingAction: 'acknowledge' },
      { type: 'actionSettled', row: { ...finding(), status: 'acknowledged' } },
    );
    expect(next.finding).toBeNull();
    expect(next.pendingAction).toBeNull();
  });
});
