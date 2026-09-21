import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import MonitorsTab from './MonitorsTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network.
const saveMock = vi.fn(async () => ({ id: 'link-1' }));
const removeMock = vi.fn(async () => true);

vi.mock('./useFeatureLink', () => ({
  useFeatureLink: () => ({
    save: saveMock,
    remove: removeMock,
    saving: false,
    error: null,
    clearError: vi.fn(),
  }),
}));

// The tab fetches the monitor catalog on mount (GET /monitor-definitions).
const { fetchWithAuthMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: [
        { id: 'm1', name: 'High CPU', kind: 'cpu', severity: 'warning', enabled: true },
        { id: 'm2', name: 'Disk full', kind: 'disk', severity: 'critical', enabled: true },
      ],
    }),
  })),
}));
vi.mock('../../../stores/auth', () => ({
  fetchWithAuth: fetchWithAuthMock,
}));

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function inlineSettingsFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

function clickSave() {
  const saveButton = screen
    .getAllByRole('button')
    .find((b) => /^save$/i.test((b.textContent ?? '').trim())) as HTMLButtonElement;
  fireEvent.click(saveButton);
}

describe('MonitorsTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    fetchWithAuthMock.mockClear();
  });

  it('attaches an existing monitor from the picker and saves it', async () => {
    render(<MonitorsTab {...baseProps} />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });

    expect(await screen.findByTestId('monitors-tab-item-m1')).toBeTruthy();

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm1', enabled: true, overrides: undefined, sortOrder: 0 },
    ]);
    const call = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null },
    ];
    expect(call[0]).toBeNull();
    expect(call[1].featureType).toBe('monitors');
    expect(call[1].featurePolicyId).toBeNull();
  });

  it('reflects a disabled toggle and a value override in the saved payload', async () => {
    render(<MonitorsTab {...baseProps} />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });
    await screen.findByTestId('monitors-tab-item-m1');

    fireEvent.click(screen.getByTestId('monitors-tab-item-enabled-m1'));
    fireEvent.change(screen.getByTestId('monitors-tab-item-override-m1'), {
      target: { value: '95' },
    });

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm1', enabled: false, overrides: { value: 95 }, sortOrder: 0 },
    ]);
  });

  it('detaching the only attached monitor and saving removes the feature link', async () => {
    const existingLink = {
      id: 'link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm1', enabled: true, sortOrder: 0 }] },
    };
    render(<MonitorsTab {...baseProps} existingLink={existingLink} />);

    await screen.findByTestId('monitors-tab-item-m1');
    fireEvent.click(screen.getByTestId('monitors-tab-item-detach-m1'));

    clickSave();

    await waitFor(() => expect(removeMock).toHaveBeenCalledWith('link-1'));
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('renders an inherited parent row as inherited without submitting it until Override is used', async () => {
    const parentLink = {
      id: 'parent-link-1',
      featureType: 'monitors' as const,
      featurePolicyId: null,
      inlineSettings: { items: [{ monitorId: 'm2', enabled: true, sortOrder: 0 }] },
    };
    render(<MonitorsTab {...baseProps} parentLink={parentLink} />);

    // Nothing is saved just by rendering the inherited state.
    expect(saveMock).not.toHaveBeenCalled();

    const row = await screen.findByTestId('monitors-tab-item-m2');
    expect(row.textContent).toContain('Inherited');

    // No Save button while fully inherited — only Override is available.
    expect(
      screen.queryAllByRole('button').find((b) => /^save$/i.test((b.textContent ?? '').trim())),
    ).toBeUndefined();

    const overrideButton = screen
      .getAllByRole('button')
      .find((b) => /override/i.test(b.textContent ?? '')) as HTMLButtonElement;
    fireEvent.click(overrideButton);

    await waitFor(() => expect(saveMock).toHaveBeenCalled());
    const call = saveMock.mock.calls[0] as unknown as [string | null, unknown];
    expect(call[0]).toBeNull();
    const inline = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(inline?.items).toEqual([
      { monitorId: 'm2', enabled: true, overrides: undefined, sortOrder: 0 },
    ]);
  });

  it('sends featurePolicyId: null even when a linked config policy is set', async () => {
    render(<MonitorsTab {...baseProps} linkedPolicyId="parent-1" />);

    const select = await screen.findByTestId('monitors-tab-attach-select');
    await waitFor(() => expect(select.querySelectorAll('option').length).toBeGreaterThan(1));
    fireEvent.change(select, { target: { value: 'm1' } });
    await screen.findByTestId('monitors-tab-item-m1');

    clickSave();

    expect(saveMock).toHaveBeenCalled();
    const call = saveMock.mock.calls[0] as unknown as [unknown, { featurePolicyId: string | null }];
    expect(call[1].featurePolicyId).toBeNull();
  });
});
