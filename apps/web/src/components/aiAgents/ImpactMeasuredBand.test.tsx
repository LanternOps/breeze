import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentImpactMeasuredDto, MeasuredCohort } from '@breeze/shared';

vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));

const { fetchWithAuth } = await import('../../stores/auth');
const { default: ImpactMeasuredBand } = await import('./ImpactMeasuredBand');

const fetchMock = vi.mocked(fetchWithAuth);

function arm(n: number, proportion = 0.6) {
  return { n, proportionWithinHorizon: proportion, censoredP50Minutes: 42, censoredP90Minutes: 300 };
}

function cohort(overrides: Partial<MeasuredCohort> = {}): MeasuredCohort {
  return {
    key: 'rule-a',
    label: 'Disk space low',
    aiTouched: arm(40, 0.8),
    untouched: arm(60, 0.5),
    ...overrides,
  };
}

function dto(overrides: Partial<AiAgentImpactMeasuredDto> = {}): AiAgentImpactMeasuredDto {
  return {
    schemaVersion: 1,
    window: 90,
    from: '2026-01-01',
    through: '2026-03-31',
    alertResolution: { cohorts: [cohort()], omitted: null, exposureAgeMinutes: 15, horizonHours: 24 },
    ticketFirstResponse: { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: 15, horizonHours: 4 },
    technicianMinutes: {
      omitted: null,
      cohorts: [{
        key: 'high|billing',
        label: 'high · billing',
        aiTouched: { n: 30, medianRecordedMinutes: 25 },
        untouched: { n: 40, medianRecordedMinutes: 35 },
      }],
      loggingCoverage: { aiTouched: 0.42, untouched: 0.31 },
    },
    ...overrides,
  };
}

function mockMeasured(body: AiAgentImpactMeasuredDto) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ data: body }),
  } as unknown as Response);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.resetAllMocks();
});

describe('ImpactMeasuredBand', () => {
  it('renders each cohort with BOTH arm sizes', async () => {
    mockMeasured(dto());

    render(<ImpactMeasuredBand window={90} />);

    const el = await screen.findByTestId('measured-cohort-rule-a');
    expect(el).toHaveTextContent('40');
    expect(el).toHaveTextContent('60');
    expect(el).toHaveTextContent('Disk space low');
  });

  it('shows an explicit not-enough-data state instead of an empty band', async () => {
    mockMeasured(dto({
      alertResolution: { cohorts: [], omitted: 'insufficient_data', exposureAgeMinutes: 15, horizonHours: 24 },
    }));

    render(<ImpactMeasuredBand window={90} />);

    expect(await screen.findByTestId('measured-alert-omitted')).toHaveTextContent(/not enough/i);
  });

  it('distinguishes not-enough-follow-up from not-enough-data', async () => {
    mockMeasured(dto({
      alertResolution: { cohorts: [], omitted: 'insufficient_followup', exposureAgeMinutes: 15, horizonHours: 24 },
    }));

    render(<ImpactMeasuredBand window={90} />);

    const el = await screen.findByTestId('measured-alert-omitted');
    expect(el.textContent).not.toMatch(/not enough data/i);
  });

  it('renders the other two signals when only technician minutes is unauthorized', async () => {
    mockMeasured(dto({ technicianMinutes: { omitted: 'insufficient_authority' } }));

    render(<ImpactMeasuredBand window={90} />);

    expect(await screen.findByTestId('measured-alert-resolution')).toBeInTheDocument();
    expect(screen.getByTestId('measured-technician-minutes-omitted')).toBeInTheDocument();
  });

  it('never says "saved" and only mentions before/after to DISCLAIM it', async () => {
    mockMeasured(dto());

    render(<ImpactMeasuredBand window={90} />);

    const text = (await screen.findByTestId('measured-band')).textContent!.toLowerCase();
    // "saved" belongs to the ESTIMATE band, which is honest about estimating.
    expect(text).not.toContain('saved');
    expect(text).toContain('correlational');
    // The phrase may appear exactly once, and only in the disclaiming form --
    // the caption's whole job is to say this is NOT a before/after comparison.
    expect(text.match(/before/g) ?? []).toHaveLength(1);
    expect(text).toContain('not a before/after comparison');
  });

  it('names the selection bias in the standing caption', async () => {
    mockMeasured(dto());

    render(<ImpactMeasuredBand window={90} />);

    expect(await screen.findByTestId('measured-caption')).toHaveTextContent(/easier items first/i);
  });

  it('shows logging coverage beside the recorded-minutes figures', async () => {
    mockMeasured(dto());

    render(<ImpactMeasuredBand window={90} />);

    const coverage = await screen.findByTestId('measured-logging-coverage');
    expect(coverage).toHaveTextContent('42');
    expect(coverage).toHaveTextContent('31');
  });

  it('labels censored percentiles as a refinement, never as a headline', async () => {
    mockMeasured(dto());

    render(<ImpactMeasuredBand window={90} />);

    expect(await screen.findByTestId('measured-censored-note')).toBeInTheDocument();
  });

  it('requests the window it was given, and refetches when it changes', async () => {
    mockMeasured(dto());

    const { rerender } = render(<ImpactMeasuredBand window={7} />);
    await screen.findByTestId('measured-band');
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('window=7'));

    rerender(<ImpactMeasuredBand window={30} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('window=30')));
  });

  it('shows an error state rather than failing silently', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) } as unknown as Response);

    render(<ImpactMeasuredBand window={90} />);

    expect(await screen.findByTestId('measured-error')).toBeInTheDocument();
  });
});
