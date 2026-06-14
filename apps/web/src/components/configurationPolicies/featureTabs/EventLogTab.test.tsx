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
});
