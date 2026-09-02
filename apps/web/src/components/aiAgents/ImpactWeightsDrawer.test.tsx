import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ImpactWeightOverrides, ImpactWeights } from '@breeze/shared';

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

function renderDrawer(overrides: {
  open?: boolean;
  effective?: ImpactWeights;
  overrides?: ImpactWeightOverrides | null;
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
  it('renders six inputs seeded from the effective weights', () => {
    renderDrawer();

    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(90);
    expect(screen.getByTestId('ai-impact-weight-noiseFlagged')).toHaveValue(240);
    expect(screen.getByTestId('ai-impact-weight-ticketTriaged')).toHaveValue(360);
    expect(screen.getByTestId('ai-impact-weight-draftSent')).toHaveValue(300);
    expect(screen.getByTestId('ai-impact-weight-fixExecuted')).toHaveValue(900);
    expect(screen.getByTestId('ai-impact-weight-narrativeDelivered')).toHaveValue(1800);
  });

  it('renders nothing when closed', () => {
    renderDrawer({ open: false });
    expect(screen.queryByTestId('ai-impact-weight-alertJudged')).not.toBeInTheDocument();
  });

  it('Save PUTs only the changed key', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { effective: { ...EFFECTIVE, alertJudged: 120 }, overrides: { alertJudged: 120 } } }),
    );
    const { onSaved } = renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/agents/impact/weights');
    expect((init as RequestInit).method).toBe('PUT');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ alertJudged: 120 });

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a value above IMPACT_WEIGHT_MAX_SECONDS is clamped client-side', async () => {
    fetchMock.mockResolvedValue(
      json({ data: { effective: { ...EFFECTIVE, alertJudged: 86_400 }, overrides: { alertJudged: 86_400 } } }),
    );
    renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '999999' } });
    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(86_400);

    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({ alertJudged: 86_400 });
  });

  it('a negative value is clamped to zero', () => {
    renderDrawer();
    fireEvent.change(screen.getByTestId('ai-impact-weight-noiseFlagged'), { target: { value: '-5' } });
    expect(screen.getByTestId('ai-impact-weight-noiseFlagged')).toHaveValue(0);
  });

  it('Reset DELETEs and does not send a body', async () => {
    fetchMock.mockResolvedValue(json({ data: { effective: EFFECTIVE, overrides: null } }));
    const { onSaved } = renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ai/agents/impact/weights');
    expect((init as RequestInit).method).toBe('DELETE');

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('a failed save toasts and does not call onSaved', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Save refused' }, false, 500));
    const { onSaved } = renderDrawer();

    fireEvent.change(screen.getByTestId('ai-impact-weight-alertJudged'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(toasts.some((toast) => toast.type === 'error')).toBe(true));
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('a failed reset toasts and does not call onSaved', async () => {
    fetchMock.mockResolvedValue(json({ error: 'Reset refused' }, false, 500));
    const { onSaved } = renderDrawer();

    fireEvent.click(screen.getByTestId('ai-impact-weights-reset'));

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
          effective: { ...EFFECTIVE, alertJudged: 120, draftSent: 400 },
          overrides: { alertJudged: 120, draftSent: 400 },
        },
      }),
    );
    const { onSaved } = renderDrawer({
      effective: { ...EFFECTIVE, alertJudged: 120 },
      overrides: { alertJudged: 120 },
    });

    // Seeded input reflects the pre-existing override, untouched this visit.
    expect(screen.getByTestId('ai-impact-weight-alertJudged')).toHaveValue(120);

    // Operator edits a DIFFERENT field only.
    fireEvent.change(screen.getByTestId('ai-impact-weight-draftSent'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('ai-impact-weights-save'));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    // BOTH keys must be present — the untouched override, and the edit.
    expect(body).toEqual({ alertJudged: 120, draftSent: 400 });

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
});
