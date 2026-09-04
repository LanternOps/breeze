import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentImpactCounters, ImpactWeightOverrides, ImpactWeights } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const toasts: Array<{ message: string; type: string }> = [];
vi.mock('../shared/Toast', () => ({
  showToast: (toast: { message: string; type: string }) => {
    toasts.push(toast);
  },
}));

import ImpactWeightsDrawer from './ImpactWeightsDrawer';
import { fetchWithAuth } from '../../stores/auth';

const fetchMock = vi.mocked(fetchWithAuth);

const json = (payload: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: 'OK', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const EFFECTIVE: ImpactWeights = {
  alertJudged: 90,
  noiseFlagged: 240,
  ticketTriaged: 360,
  draftSent: 300,
  fixExecuted: 900,
  narrativeDelivered: 1800,
};

// Chosen so `estimateSecondsSaved` produces a clean, hand-verifiable number:
// only alertsJudged is non-zero, and 40 * 90s (the alertJudged default) is
// exactly 3600s = 1 hour — a round baseline the preview tests below build on.
const COUNTERS: AiAgentImpactCounters = {
  alertsJudged: 40,
  noiseFlagged: 0,
  suppressionsApplied: 0,
  ticketsTriaged: 0,
  draftsSent: 0,
  fixesProposed: 0,
  fixesExecuted: 0,
  fixWatchesHeld: 0,
  fixWatchesRecurred: 0,
  narrativesDelivered: 0,
};

function renderDrawer(overrides: {
  open?: boolean;
  effective?: ImpactWeights;
  overrides?: ImpactWeightOverrides | null;
  counters?: AiAgentImpactCounters;
  onClose?: () => void;
  onSaved?: () => void;
} = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const onSaved = overrides.onSaved ?? vi.fn();
  const view = render(
    <ImpactWeightsDrawer
      open={overrides.open ?? true}
      effective={overrides.effective ?? EFFECTIVE}
      overrides={overrides.overrides ?? null}
      counters={overrides.counters ?? COUNTERS}
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { view, onClose, onSaved };
}

beforeEach(() => {
  fetchMock.mockReset();
  toasts.length = 0;
});

describe('ImpactWeightsDrawer', () => {
  it('renders six inputs seeded from the effective weights, in MINUTES', () => {
    renderDrawer();

    // 90s, 240s, 360s, 300s, 900s, 1800s -> 1.5, 4, 6, 5, 15, 30 minutes.
    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(1.5);
    expect(screen.getByTestId('ai-impact-weight-noiseFlagged')).toHaveValue(4);
    expect(screen.getByTestId('ai-impact-weight-ticketTriaged')).toHaveValue(6);
    expect(screen.getByTestId('ai-impact-weight-draftSent')).toHaveValue(5);
    expect(screen.getByTestId('ai-impact-weight-fixExecuted')).toHaveValue(15);
    expect(screen.getByTestId('ai-impact-weight-narrativeDelivered')).toHaveValue(30);
  });

  it('renders a "min" unit suffix inside every field, not just in the intro paragraph', () => {
    renderDrawer();

    for (const key of ['alertJudged', 'noiseFlagged', 'ticketTriaged', 'draftSent', 'fixExecuted', 'narrativeDelivered']) {
      const suffix = screen.getByTestId(`ai-impact-weight-${key}-unit`);
      expect(suffix).toHaveTextContent('min');
      // Wired accessibly to the input, not a decorative-only label.
      expect(screen.getByTestId(`ai-impact-weight-${key}`)).toHaveAttribute(
        'aria-describedby',
        suffix.id,
      );
    }
  });

  it('hides the native number-input spinner so it cannot collide with the "min" suffix', () => {
    renderDrawer();

    for (const key of ['alertJudged', 'noiseFlagged', 'ticketTriaged', 'draftSent', 'fixExecuted', 'narrativeDelivered']) {
      const input = screen.getByTestId(`ai-impact-weight-${key}`);
      expect(input.className).toContain('[appearance:textfield]');
      expect(input.className).toContain('[&::-webkit-inner-spin-button]:appearance-none');
      expect(input.className).toContain('[&::-webkit-outer-spin-button]:appearance-none');
    }
  });

  it('shows each field\'s default value beside the current value', () => {
    renderDrawer();

    // Defaults (seconds -> minutes): alertJudged 90s=1.5, noiseFlagged 240s=4,
    // ticketTriaged 360s=6, draftSent 300s=5, fixExecuted 900s=15,
    // narrativeDelivered 1800s=30.
    expect(screen.getByTestId('ai-impact-weight-alertJudged-default')).toHaveTextContent('1.5');
    expect(screen.getByTestId('ai-impact-weight-fixExecuted-default')).toHaveTextContent('15');
    expect(screen.getByTestId('ai-impact-weight-narrativeDelivered-default')).toHaveTextContent('30');
  });

  it('shows a visible min/max range hint for the minute fields', () => {
    renderDrawer();
    expect(screen.getByTestId('ai-impact-weights-range-hint')).toHaveTextContent('0');
    expect(screen.getByTestId('ai-impact-weights-range-hint')).toHaveTextContent('1440');
  });

  it('accepts a decimal (0.5-minute step) value', () => {
    renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '2.5' } });
    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(2.5);
  });

  it('P1 regression: typing a decimal keystroke-by-keystroke does not snap back to a whole number, and saves the decimal', async () => {
    // Reproduces the real defect: `<input type="number">`'s value-sanitization
    // algorithm reports "" (not "2.") for the intermediate "2." a user's
    // keystrokes pass through on the way to "2.5" — confirmed identically in
    // jsdom. The OLD bug: a `number` draft state ran `Number('')` (== 0)
    // through every keystroke, so the box re-rendered showing "0", stranding
    // the "2" already typed. The fix holds the draft as text, so an
    // in-progress "" does not force a wrong number into the box.
    fetchMock.mockResolvedValue(json({ data: { effective: EFFECTIVE, overrides: null } }));
    const { onSaved } = renderDrawer();
    const input = screen.getByTestId('ai-impact-weight-alertJudged');

    fireEvent.change(input, { target: { value: '2' } });
    expect(input).toHaveValue(2);

    // What the browser (and jsdom) actually reports mid-keystroke for "2.".
    fireEvent.change(input, { target: { value: '' } });
    // The OLD code would have shown 0 here (Number('') coerced into state).
    expect(input).not.toHaveValue(0);

    fireEvent.change(input, { target: { value: '2.5' } });
    expect(input).toHaveValue(2.5);

    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // 2.5 minutes -> 150 seconds. The old bug would have saved 0.
    expect(body).toEqual({ alertJudged: 150 });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('renders nothing when closed', () => {
    renderDrawer({ open: false });
    expect(screen.queryByTestId('ai-impact-weight-alertJudged')).not.toBeInTheDocument();
  });

  it('Save PUTs only the changed key, converted to SECONDS at the API boundary', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { effective: { ...EFFECTIVE, alertJudged: 120 }, overrides: { alertJudged: 120 } } }),
    );
    const { onSaved } = renderDrawer();

    // 2 minutes -> 120 seconds.
    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/agents/impact/weights');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ alertJudged: 120 });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a value above IMPACT_WEIGHT_MAX_SECONDS (in minutes) is preserved while typing, clamped on blur, and clamped at save regardless', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { effective: { ...EFFECTIVE, alertJudged: 86_400 }, overrides: { alertJudged: 86_400 } } }),
    );
    renderDrawer();
    const input = screen.getByTestId('ai-impact-weight-alertJudged');

    fireEvent.change(input, { target: { value: '999999' } });
    // Not clamped mid-edit — see the P1 regression test above for why.
    expect(input).toHaveValue(999_999);

    fireEvent.blur(input);
    // 86,400s max == 1,440 minutes.
    expect(input).toHaveValue(1_440);

    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ alertJudged: 86_400 });
  });

  it('a negative value is preserved while typing and clamped to zero on blur', () => {
    renderDrawer();
    const input = screen.getByTestId('ai-impact-weight-noiseFlagged');

    fireEvent.change(input, { target: { value: '-5' } });
    expect(input).toHaveValue(-5);

    fireEvent.blur(input);
    expect(input).toHaveValue(0);
  });

  it('a value above the max is still clamped at Save even without a blur first', async () => {
    // The display-clamp is a UX nicety at blur; the two API boundaries
    // (`minutesToSeconds`/`clampMinutes`) must clamp regardless of whether
    // the field was ever blurred.
    fetchMock.mockResolvedValue(
      json({ data: { effective: { ...EFFECTIVE, alertJudged: 86_400 }, overrides: { alertJudged: 86_400 } } }),
    );
    renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '999999' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ alertJudged: 86_400 });
  });

  it('clicking Reset opens a confirm dialog instead of DELETing immediately', () => {
    renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));

    expect(fetchMock).not.toHaveBeenCalled();
    const confirmButton = screen.getByTestId('ai-impact-weights-reset-confirm');
    expect(confirmButton).toBeInTheDocument();
    // States what reverts and what changes as a result, not a bare Yes/No.
    expect(screen.getByText(/all six weights revert to their default allowances/i)).toBeInTheDocument();
    expect(
      screen.getByText(/estimated time saved on this page changes to match/i),
    ).toBeInTheDocument();
  });

  it('confirming the reset dialog DELETEs and does not send a body', async () => {
    fetchMock.mockResolvedValue(json({ data: { effective: EFFECTIVE, overrides: null } }));
    const { onSaved } = renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));
    fireEvent.click(screen.getByTestId('ai-impact-weights-reset-confirm'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/agents/impact/weights');
    expect((init as RequestInit).method).toBe('DELETE');

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('P3 regression: focus returns to the (re-enabled) Reset button after a completed reset, not to document.body', async () => {
    // The confirm dialog restores focus to whatever was active when it
    // opened (the Reset trigger button) as soon as it closes. Closing it
    // synchronously on click — while the trigger was still mid-request and
    // therefore `disabled` — sent focus nowhere. Closing only after the
    // request settles (and `busy` clears) means the trigger is enabled again
    // by the time the dialog's own close-focus effect runs.
    fetchMock.mockResolvedValue(json({ data: { effective: EFFECTIVE, overrides: null } }));
    renderDrawer();

    // `userEvent.click` (not `fireEvent.click`) is required here: it drives
    // the full pointer sequence including the browser's default focus-on-click
    // action, which is what actually puts the Reset button in
    // `document.activeElement` for the dialog's own open-time capture below
    // to see — the same precondition that holds in a real browser.
    await userEvent.click(screen.getByTestId('ai-impact-weights-reset'));
    fireEvent.click(screen.getByTestId('ai-impact-weights-reset-confirm'));

    await waitFor(() =>
      expect(screen.queryByTestId('ai-impact-weights-reset-confirm')).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId('ai-impact-weights-reset')),
    );
    expect(document.activeElement).not.toBe(document.body);
  });

  it('closing the reset confirm dialog leaves the stored weights untouched', () => {
    renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));
    expect(screen.getByTestId('ai-impact-weights-reset-confirm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByTestId('ai-impact-weights-reset-confirm')).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a failed save toasts and does not call onSaved', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Save refused' }, false, 500));
    const { onSaved } = renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '2' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a failed reset toasts and does not call onSaved', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Reset refused' }, false, 500));
    const { onSaved } = renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));
    fireEvent.click(screen.getByTestId('ai-impact-weights-reset-confirm'));

    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('shows a customized badge only for fields carrying a stored override', () => {
    renderDrawer({ overrides: { alertJudged: 120 } });

    expect(screen.getByTestId('ai-impact-weight-alertJudged-customized')).toBeInTheDocument();
    expect(screen.queryByTestId('ai-impact-weight-noiseFlagged-customized')).not.toBeInTheDocument();
  });

  it('Save with a pre-existing stored override preserves it alongside the edited key', async () => {
    // Regression for the Critical finding: the PUT route REPLACES the whole
    // stored-weights column, so a partial body built by diffing against
    // `effective` (defaults + pre-existing overrides) would silently drop
    // any override the operator didn't touch this visit. Diffing against
    // DEFAULT_IMPACT_WEIGHTS must send the untouched override too.
    fetchMock.mockResolvedValue(
      json({
        data: {
          effective: { ...EFFECTIVE, alertJudged: 120, draftSent: 480 },
          overrides: { alertJudged: 120, draftSent: 480 },
        },
      }),
    );
    const { onSaved } = renderDrawer({
      effective: { ...EFFECTIVE, alertJudged: 120 },
      overrides: { alertJudged: 120 },
    });

    // Seeded input reflects the pre-existing override (120s = 2min), untouched this visit.
    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(2);

    // Operator edits a DIFFERENT field only: 8 minutes -> 480 seconds.
    fireEvent.change(screen.getByTestId('ai-impact-weight-draftSent'), { target: { value: '8' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // BOTH keys must be present — the untouched override, and the edit.
    expect(body).toEqual({ alertJudged: 120, draftSent: 480 });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a no-edit Save with pre-existing stored overrides re-sends them (not an accidental reset)', async () => {
    // Regression for the locked-in-by-a-test half of the Critical finding:
    // Save with NO edits must NOT send `{}` when overrides already exist —
    // that would perform a full reset while reporting success.
    fetchMock.mockResolvedValue(
      json({
        data: {
          effective: { ...EFFECTIVE, alertJudged: 120, noiseFlagged: 500 },
          overrides: { alertJudged: 120, noiseFlagged: 500 },
        },
      }),
    );
    renderDrawer({
      effective: { ...EFFECTIVE, alertJudged: 120, noiseFlagged: 500 },
      overrides: { alertJudged: 120, noiseFlagged: 500 },
    });

    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // 500s round-trips through the minutes editor (8.33min) back to 500s exactly.
    expect(body).toEqual({ alertJudged: 120, noiseFlagged: 500 });
  });

  it('sends no body when nothing changed from the effective values', async () => {
    fetchMock.mockResolvedValue(json({ data: { effective: EFFECTIVE, overrides: null } }));
    renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({});
  });

  describe('live re-pricing preview', () => {
    it('shows the current estimate on open, unchanged on both sides before any edit, correctly singular at exactly 1', () => {
      renderDrawer();

      // COUNTERS.alertsJudged=40 * EFFECTIVE.alertJudged=90s = 3600s = 1 hour
      // exactly — the i18next plural family must select "_one" ("1 hour"),
      // not "_other" ("1 hours") hard-coded regardless of count.
      const preview = screen.getByTestId('ai-impact-weights-preview');
      expect(preview).toHaveTextContent('1 hour →');
      expect(preview).not.toHaveTextContent('1 hours');
      expect(preview).toHaveTextContent('Estimated time saved this window');
    });

    it('updates the "to" side as a weight field changes, leaving the "from" side alone, and pluralizes once above 1', () => {
      renderDrawer();
      const preview = screen.getByTestId('ai-impact-weights-preview');
      expect(preview).toHaveTextContent('1 hour → 1 hour');

      // 90s -> 180s (3 minutes): 40 * 180s = 7200s = 2 hours.
      fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '3' } });

      expect(preview).toHaveTextContent('1 hour → 2 hours');
    });

    it('replaces the "0 hours → 0 hours" preview with a no-outcomes message when the window has no priced activity', () => {
      const ZERO_COUNTERS: AiAgentImpactCounters = {
        alertsJudged: 0,
        noiseFlagged: 0,
        suppressionsApplied: 0,
        ticketsTriaged: 0,
        draftsSent: 0,
        fixesProposed: 0,
        fixesExecuted: 0,
        fixWatchesHeld: 0,
        fixWatchesRecurred: 0,
        narrativesDelivered: 0,
      };
      renderDrawer({ counters: ZERO_COUNTERS });

      const preview = screen.getByTestId('ai-impact-weights-preview');
      expect(preview).toHaveTextContent('No outcomes in this window to preview against');
      expect(preview).not.toHaveTextContent('0 hours');
      expect(preview).not.toHaveTextContent('→');
    });
  });
});
