import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import EventLogTab from './EventLogTab';

const saveMock = vi.fn();
const removeMock = vi.fn();
const clearErrorMock = vi.fn();

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: undefined,
    clearError: clearErrorMock,
  }),
}));

describe('EventLogTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({
      id: 'link-1',
      featureType: 'event_log',
      featurePolicyId: null,
      inlineSettings: {},
    });
  });

  it('renders the always-on collection clarification copy', () => {
    render(
      <EventLogTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    expect(screen.getByText(/collected from all devices by default/i)).toBeTruthy();
    expect(screen.getByText(/do not turn collection on or off/i)).toBeTruthy();
  });

  it('does not render the removed dead toggles', () => {
    render(
      <EventLogTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    expect(screen.queryByText(/Full-text search/i)).toBeNull();
    expect(screen.queryByText(/Correlation detection/i)).toBeNull();
  });

  it('omits enableFullTextSearch / enableCorrelation from the save payload', async () => {
    render(
      <EventLogTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const [, payload] = saveMock.mock.calls[0] as [
      string | null,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(payload.inlineSettings).not.toHaveProperty('enableFullTextSearch');
    expect(payload.inlineSettings).not.toHaveProperty('enableCorrelation');
    // The genuinely-wired knobs are still sent.
    expect(payload.inlineSettings).toHaveProperty('retentionDays');
    expect(payload.inlineSettings).toHaveProperty('collectCategories');
    expect(payload.inlineSettings).toHaveProperty('minimumLevel');
  });

  it('drops legacy dead toggles even when present on the existing link', async () => {
    render(
      <EventLogTab
        policyId="policy-1"
        existingLink={{
          id: 'link-1',
          featureType: 'event_log',
          featurePolicyId: null,
          inlineSettings: {
            retentionDays: 30,
            maxEventsPerCycle: 100,
            collectCategories: ['security', 'hardware', 'application', 'system'],
            minimumLevel: 'info',
            collectionIntervalMinutes: 5,
            rateLimitPerHour: 12000,
            // Legacy fields that used to be persisted.
            enableFullTextSearch: true,
            enableCorrelation: true,
          },
        }}
        linkedPolicyId={null}
        onLinkChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));

    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const [, payload] = saveMock.mock.calls[0] as [
      string | null,
      { inlineSettings: Record<string, unknown> },
    ];
    expect(payload.inlineSettings).not.toHaveProperty('enableFullTextSearch');
    expect(payload.inlineSettings).not.toHaveProperty('enableCorrelation');
  });

  // #5080: `featurePolicyId` means a standalone entity id — Event Log is
  // inline settings, so it must never carry the parent CONFIG policy's id.
  it('sends featurePolicyId: null even when a parent config policy is linked', async () => {
    render(
      <EventLogTab
        policyId="policy-1"
        existingLink={undefined}
        linkedPolicyId="parent-1"
        onLinkChanged={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());

    const [, payload] = saveMock.mock.calls[0] as [string | null, { featurePolicyId: string | null }];
    expect(payload.featurePolicyId).toBeNull();
  });
});


describe('EventLogTab application providers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    saveMock.mockResolvedValue({ id: 'link-1', featureType: 'event_log', inlineSettings: {} });
  });

  function mount(applicationProviders?: unknown) {
    return render(<EventLogTab policyId="policy-1" linkedPolicyId={null} onLinkChanged={vi.fn()}
      existingLink={applicationProviders === undefined ? undefined : {
        id: 'link-1', featureType: 'event_log', featurePolicyId: null,
        inlineSettings: { applicationProviders },
      }} />);
  }

  it('adds trimmed providers by button and Enter, deduplicates ignoring case, and saves them', async () => {
    mount();
    const input = screen.getByTestId('event-log-app-providers-input');
    fireEvent.change(input, { target: { value: ' Dell UPS Local Node Manager ' } });
    fireEvent.click(screen.getByTestId('event-log-app-providers-add'));
    fireEvent.change(input, { target: { value: 'dell ups local node manager' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getAllByTestId('event-log-app-providers-item')).toHaveLength(1);
    fireEvent.change(input, { target: { value: 'MSSQL$SQLEXPRESS' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].inlineSettings.applicationProviders)
      .toEqual(['Dell UPS Local Node Manager', 'MSSQL$SQLEXPRESS']);
  });

  it.each(["Foo' or '1'='1", 'A[B]', 'a;b', '.NET Runtime', 'A'.repeat(257), '   '])('rejects invalid provider %s inline', (provider) => {
    mount();
    fireEvent.change(screen.getByTestId('event-log-app-providers-input'), { target: { value: provider } });
    fireEvent.click(screen.getByTestId('event-log-app-providers-add'));
    expect(screen.queryAllByTestId('event-log-app-providers-item')).toHaveLength(0);
    expect(screen.getByTestId('event-log-app-providers-error').textContent).toBeTruthy();
  });

  it('disables Add at 20 and allows removing a provider', () => {
    mount(Array.from({ length: 20 }, (_, i) => `Provider${i}`));
    expect((screen.getByTestId('event-log-app-providers-add') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getAllByTestId('event-log-app-providers-remove')[0]);
    expect(screen.getAllByTestId('event-log-app-providers-item')).toHaveLength(19);
    expect((screen.getByTestId('event-log-app-providers-add') as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows a limit error when Enter is pressed at 20 providers', () => {
    mount(Array.from({ length: 20 }, (_, i) => `Provider${i}`));
    const input = screen.getByTestId('event-log-app-providers-input');
    fireEvent.change(input, { target: { value: 'UPS' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.getByTestId('event-log-app-providers-error').textContent)
      .toBe('You can list up to 20 additional providers. Remove one to add another.');
    expect(screen.getAllByTestId('event-log-app-providers-item')).toHaveLength(20);
    expect((input as HTMLInputElement).value).toBe('UPS');
  });

  it('normalizes legacy non-array data to an empty list in the save payload', async () => {
    mount('legacy');
    fireEvent.click(screen.getByRole('button', { name: /^Save$/i }));
    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    expect(saveMock.mock.calls[0][1].inlineSettings.applicationProviders).toEqual([]);
  });
});
