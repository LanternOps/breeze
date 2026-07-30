import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import MonitoringTab from './MonitoringTab';
import { fetchWithAuth } from '../../../stores/auth';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
}));

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

const fetchMock = vi.mocked(fetchWithAuth);

const makeJsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? 'OK' : 'ERROR',
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

// The disclosure header is a role="button" wrapper around the section title.
function sectionHeader(title: string): HTMLElement {
  const header = screen.getByText(title).closest('[role="button"]');
  if (!header) throw new Error(`No disclosure header found for section "${title}"`);
  return header as HTMLElement;
}

function renderTab() {
  return render(
    <MonitoringTab
      policyId="policy-1"
      existingLink={undefined}
      linkedPolicyId={null}
      onLinkChanged={vi.fn()}
    />,
  );
}

// Alert-rule ownership moved to the alert_rule feature link (2026-07-30
// consolidation). The API now REJECTS a monitoring payload carrying either key,
// so this tab must neither render editors for them nor echo a legacy link's
// values back on save.
describe('MonitoringTab alert-rule consolidation', () => {
  const legacyLink = {
    id: 'link-1',
    featureType: 'monitoring' as const,
    featurePolicyId: null,
    inlineSettings: {
      checkIntervalSeconds: 90,
      watches: [
        {
          watchType: 'service',
          name: 'nginx',
          enabled: true,
          alertOnStop: true,
          alertAfterConsecutiveFailures: 2,
          alertSeverity: 'high',
          thresholdDurationSeconds: 300,
          autoRestart: false,
          maxRestartAttempts: 3,
          restartCooldownSeconds: 300,
        },
      ],
      // Pre-consolidation rows, still persisted on the link.
      eventLogAlerts: [
        {
          name: 'Security errors',
          category: 'security',
          level: 'error',
          countThreshold: 1,
          windowMinutes: 15,
          severity: 'high',
          enabled: true,
        },
      ],
      alertRules: [
        {
          name: 'High CPU',
          severity: 'high',
          conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 80 }],
          cooldownMinutes: 15,
          autoResolve: false,
        },
      ],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'monitoring',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('renders no metric-rule or event-log-rule editor, only a pointer to the Alerts feature', () => {
    renderTab();

    expect(screen.queryByText('Metric & Status Alert Rules')).toBeNull();
    expect(screen.queryByText('Event Log Alerts')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Rule' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add Alert' })).toBeNull();
    // The surviving agent-side section is untouched.
    expect(screen.getByText('Service & Process Watches')).toBeTruthy();
    expect(screen.getByTestId('monitoring-alerts-pointer').textContent).toContain(
      'configured in the Alerts feature',
    );
  });

  it('omits alertRules/eventLogAlerts from the save payload entirely', async () => {
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const settings = saveMock.mock.calls.at(-1)![1].inlineSettings as Record<string, unknown>;
    expect(Object.keys(settings).sort()).toEqual(['checkIntervalSeconds', 'watches']);
  });

  it('does not echo a legacy link\'s alertRules/eventLogAlerts back on save', async () => {
    render(
      <MonitoringTab
        policyId="policy-1"
        existingLink={legacyLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const settings = saveMock.mock.calls.at(-1)![1].inlineSettings as Record<string, unknown>;
    expect(settings).not.toHaveProperty('alertRules');
    expect(settings).not.toHaveProperty('eventLogAlerts');
    // The keys this tab still owns survive the round-trip.
    expect(settings.checkIntervalSeconds).toBe(90);
    expect(settings.watches).toHaveLength(1);
  });

  it('tells the tech where the legacy rules went instead of dropping them silently', () => {
    render(
      <MonitoringTab
        policyId="policy-1"
        existingLink={legacyLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );

    const notice = screen.getByTestId('monitoring-legacy-alert-rules-notice');
    // One alertRules entry + one eventLogAlerts entry on the fixture link.
    expect(notice.textContent).toContain('2');
    expect(notice.textContent).toContain('Alerts');
    // Non-blocking: saving the tab still works.
    expect(
      (screen.getByRole('button', { name: /^Save$/i }) as HTMLButtonElement).disabled
    ).toBe(false);
  });

  it('shows no legacy notice for a link that never carried alert rules', () => {
    renderTab();
    expect(screen.queryByTestId('monitoring-legacy-alert-rules-notice')).toBeNull();
  });

  it('navigates to the Alerts tab from the legacy notice', () => {
    render(
      <MonitoringTab
        policyId="policy-1"
        existingLink={legacyLink}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />,
    );

    window.location.hash = '';
    fireEvent.click(screen.getByTestId('monitoring-legacy-alert-rules-link'));
    expect(window.location.hash).toBe('#alert_rule');
  });
});

describe('MonitoringTab disclosure keyboard toggle (issue #1932)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // known-services autocomplete fetch on mount
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
  });

  it('wires aria-controls to the rendered region id when expanded', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(header, { key: 'Enter' });

    const panelId = header.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    // The region the header controls is now rendered with the matching id.
    expect(document.getElementById(panelId!)).not.toBeNull();
  });

  it('toggles the section open and closed on Enter', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/No watches configured yet/i)).toBeTruthy();

    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();
  });

  it('toggles the section on Space and calls preventDefault to avoid page scroll', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // Dispatch a real, cancelable keydown so we can observe preventDefault.
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, 'preventDefault');
    fireEvent(header, event);

    expect(preventDefaultSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });

  it('does not toggle when the keydown originates from a nested action button', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    // The "Add Watch" button lives inside the header; a keydown on it has
    // event.target !== event.currentTarget and must be ignored by the guard.
    // Exact name avoids matching the header role="button", whose accessible
    // name also contains the nested "Add Watch" button text.
    const addButton = screen.getByRole('button', { name: 'Add Watch' });
    fireEvent.keyDown(addButton, { key: 'Enter' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText(/No watches configured yet/i)).toBeNull();
  });

  it('ignores keys other than Enter and Space', () => {
    renderTab();

    const header = sectionHeader('Service & Process Watches');
    expect(header.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(header, { key: 'a' });
    fireEvent.keyDown(header, { key: 'ArrowDown' });

    expect(header.getAttribute('aria-expanded')).toBe('false');
  });
});

// The feature-tab strip in ConfigPolicyDetailPage is hash-driven (useHashTab),
// so the pointer switches tabs by writing `#alert_rule` — exactly what the
// strip's own buttons do.
describe('MonitoringTab pointer to the Alerts feature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue(makeJsonResponse({ data: [] }));
    window.location.hash = '#monitoring';
  });

  it('navigates to the alert_rule tab when the pointer link is clicked', () => {
    renderTab();

    const link = screen.getByTestId('monitoring-alerts-pointer-link');
    expect(within(screen.getByTestId('monitoring-alerts-pointer')).getByTestId(
      'monitoring-alerts-pointer-link',
    )).toBe(link);

    fireEvent.click(link);

    expect(window.location.hash).toBe('#alert_rule');
  });

  it('keeps the explanatory sentence alongside the link', () => {
    renderTab();

    const pointer = screen.getByTestId('monitoring-alerts-pointer');
    expect(pointer.textContent).toContain('configured in the Alerts feature');
    expect(pointer.textContent).toContain('Open Alerts');
  });
});
