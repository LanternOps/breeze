import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AnomalyEpisodeCard from './AnomalyEpisodeCard';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { MetricAnomalyEpisodeDto } from '@breeze/shared';

const showToast = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: vi.fn(), registerOrgIdProvider: vi.fn() }));
vi.mock('../shared/Toast', () => ({ showToast: (input: unknown) => showToast(input) }));

const fetchWithAuthMock = vi.mocked(fetchWithAuth);
const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERROR', json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

function baseEpisode(overrides: Partial<MetricAnomalyEpisodeDto> = {}): MetricAnomalyEpisodeDto {
  return {
    id: 'episode-1', orgId: 'org-1', deviceId: 'dev-1',
    episodeKey: 'device_metrics:spike:disk_write', sourceTable: 'device_metrics',
    anomalyType: 'spike', metricFamily: 'disk_write', metricNames: ['disk_write_bps'],
    status: 'open', closeReason: null,
    firstSeenAt: '2026-06-18T22:35:00.000Z', lastSeenAt: '2026-06-18T23:55:00.000Z',
    bucketCount: 17, peakValue: 153_000_000, peakMetricName: 'disk_write_bps',
    peakBaselineValue: 6_000_000, peakScore: 9.1, peakAt: '2026-06-18T23:50:00.000Z',
    recurrenceCount: 0, attribution: null, linkedAlertId: null, snoozedUntil: null,
    resolvedAt: null, resolvedByUserId: null, note: null,
    createdAt: '2026-06-18T22:35:00.000Z', updatedAt: '2026-06-18T23:55:00.000Z',
    durationSeconds: 4800, ongoing: true, promoted: false, snoozed: false,
    rangeMin: 86_000_000, rangeMax: 153_000_000, peakAnomalyId: 'anomaly-peak', deviceLastSeenAt: null,
    ...overrides,
  } as MetricAnomalyEpisodeDto;
}

const patchMeta = { alertId: null, alertResolved: false, labelledMembers: 17 };

const flags = (remediationEnabled = false, shadowEnabled = false) => ({
  mlFeatureFlags: {
    'ml.anomalies.enabled': { flag: 'ml.anomalies.enabled', enabled: true, defaultEnabled: false, source: 'org_settings' },
    'ml.remediation_suggestions.enabled': { flag: 'ml.remediation_suggestions.enabled', enabled: remediationEnabled, defaultEnabled: false, source: 'org_settings' },
    'ml.anomalies.v1_shadow.enabled': { flag: 'ml.anomalies.v1_shadow.enabled', enabled: shadowEnabled, defaultEnabled: false, source: 'org_settings' },
  },
});

describe('AnomalyEpisodeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showToast.mockReset();
    useOrgStore.setState({ currentOrgId: 'org-1' });
    fetchWithAuthMock.mockImplementation((input) => {
      if (String(input) === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${input}` }, false, 404));
    });
  });

  it('renders the sentence headline and an ongoing chip for an open episode', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    expect(await screen.findByText(/Disk write has been/)).toBeTruthy();
    expect(screen.getByTestId('anomaly-episode-chip-ongoing')).toBeTruthy();
  });

  it('shows a recurrence chip when recurrenceCount >= 1', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ recurrenceCount: 2 })} onChanged={vi.fn()} />);
    expect(await screen.findByText('3rd time in 7 days')).toBeTruthy();
  });

  it('dismiss calls the PATCH action via runAction and reports the update', async () => {
    const onChanged = vi.fn();
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        expect(init.body).toBe(JSON.stringify({ action: 'dismiss' }));
        return Promise.resolve(makeJsonResponse({ data: baseEpisode({ status: 'dismissed', closeReason: 'user', ongoing: false }), meta: patchMeta }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={onChanged} />);
    fireEvent.click(await screen.findByRole('button', { name: /dismiss for 7 days/i }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' })));
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('a 409 { error, reason } asks the panel to refetch and does not report an update', async () => {
    const onChanged = vi.fn();
    const onStale = vi.fn();
    fetchWithAuthMock.mockImplementation((input, init) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1' && init?.method === 'PATCH') {
        return Promise.resolve(makeJsonResponse({ error: 'This anomaly has already closed', reason: 'episode_closed' }, false, 409));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={onChanged} onStale={onStale} />);
    fireEvent.click(await screen.findByRole('button', { name: /^resolve$/i }));

    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(onChanged).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message: 'This anomaly has already closed' }));
  });

  it('an expired_offline chip says when the device was last seen (A9)', async () => {
    render(
      <AnomalyEpisodeCard
        deviceId="dev-1"
        episode={baseEpisode({ status: 'resolved', closeReason: 'expired_offline', ongoing: false, deviceLastSeenAt: '2026-06-17T09:00:00.000Z' })}
        onChanged={vi.fn()}
      />,
    );
    const chip = await screen.findByTestId('anomaly-episode-chip-closed');
    expect(chip.textContent).toMatch(/^expired: device not seen since \S/);
    expect(chip.textContent).not.toContain('–'); // no window range on an expired chip
  });

  it('an expired_offline chip without a last-seen time falls back to the plain label', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ status: 'resolved', closeReason: 'expired_offline', ongoing: false })} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('anomaly-episode-chip-closed')).textContent).toBe('expired: device not seen');
  });

  it('a detection_off close reads "closed: detection turned off" (A5)', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ status: 'resolved', closeReason: 'detection_off', ongoing: false })} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('anomaly-episode-chip-closed')).textContent).toBe('closed: detection turned off');
  });

  it('a user close reads "dismissed" for a dismissed episode once its snooze has lapsed, "resolved" for a resolved one', async () => {
    const { unmount } = render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ status: 'dismissed', closeReason: 'user', ongoing: false, snoozed: false })} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('anomaly-episode-chip-closed')).textContent).toMatch(/· dismissed$/);
    unmount();
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ status: 'resolved', closeReason: 'user', ongoing: false })} onChanged={vi.fn()} />);
    expect((await screen.findByTestId('anomaly-episode-chip-closed')).textContent).toMatch(/· resolved$/);
  });

  it('shows Stop snoozing for a dismissed-and-snoozed episode instead of Dismiss/Resolve', async () => {
    render(
      <AnomalyEpisodeCard
        deviceId="dev-1"
        episode={baseEpisode({ status: 'dismissed', closeReason: 'snoozed', ongoing: false, snoozed: true, snoozedUntil: '2026-09-28T00:00:00.000Z' })}
        onChanged={vi.fn()}
      />,
    );
    expect(await screen.findByRole('button', { name: /stop snoozing/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^dismiss for 7 days$/i })).toBeNull();
    expect(screen.getByText(/Dismissed/)).toBeTruthy();
  });

  it('shows Open alert instead of Promote when already promoted', async () => {
    render(
      <AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode({ linkedAlertId: 'alert-1', promoted: true })} onChanged={vi.fn()} />,
    );
    expect(await screen.findByRole('link', { name: /open alert/i })).toHaveAttribute('href', '/alerts/alert-1');
    expect(screen.queryByRole('button', { name: /promote to alert/i })).toBeNull();
  });

  it('renders no actions in compact mode', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} compact onChanged={vi.fn()} />);
    await screen.findByText(/Disk write has been/);
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /resolve/i })).toBeNull();
  });

  it('hides the remediation block when the flag is off and shows it when on', async () => {
    // RemediationSuggestionsPanel's actual heading is "Suggested Fixes"
    // (longTail.remediation.RemediationSuggestionsPanel.title in
    // locales/en/common.json) — the plan's literal test text
    // ("Remediation suggestions") does not match the shipped copy.
    const { unmount } = render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    await screen.findByText(/Disk write has been/);
    expect(screen.queryByText('Suggested Fixes')).toBeNull();
    unmount();

    // useMlFeatureFlags only reloads when `currentOrgId` changes (its effect
    // deps), so a same-instance rerender would keep the first flag fetch's
    // result — remount fresh instead of using testing-library's `rerender`.
    fetchWithAuthMock.mockImplementation((input) => {
      if (String(input) === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags(true)));
      if (String(input).startsWith('/remediation-suggestions')) return Promise.resolve(makeJsonResponse({ data: [] }));
      return Promise.resolve(makeJsonResponse({ error: 'unexpected' }, false, 404));
    });
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    expect(await screen.findByText('Suggested Fixes')).toBeTruthy();
    // Keyed on the peak MEMBER (sourceType 'anomaly'), never the episode id.
    expect(fetchWithAuthMock).toHaveBeenCalledWith(expect.stringContaining('sourceId=anomaly-peak'));
  });

  it('toggles the member table on the detections chip', async () => {
    fetchWithAuthMock.mockImplementation((input) => {
      const url = String(input);
      if (url === '/config/ml-feature-flags') return Promise.resolve(makeJsonResponse(flags()));
      if (url === '/devices/dev-1/anomaly-episodes/episode-1') {
        return Promise.resolve(makeJsonResponse({
          data: {
            ...baseEpisode(),
            members: [{
              id: 'm-1', metricName: 'disk_write_bps', anomalyType: 'spike', status: 'cleared',
              windowStart: '2026-06-18T22:35:00.000Z', windowEnd: '2026-06-18T22:40:00.000Z',
              observedValue: 86_000_000, baselineValue: 6_000_000, baselineMax: 11_000_000,
              score: 8.1, confidence: 0.9, linkedAlertId: null,
            }],
            membersTruncated: false,
          },
        }));
      }
      return Promise.resolve(makeJsonResponse({ error: `unexpected ${url}` }, false, 404));
    });

    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /17 detections/i }));
    expect(await screen.findByTestId('anomaly-episode-member-m-1')).toBeTruthy();
  });

  it('gets the focused ring when focused is true', async () => {
    render(<AnomalyEpisodeCard deviceId="dev-1" episode={baseEpisode()} focused onChanged={vi.fn()} />);
    expect(await screen.findByTestId('anomaly-episode-episode-1')).toHaveClass('ring-2');
  });
});
