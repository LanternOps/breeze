import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RemoteAccessTab from './RemoteAccessTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network. We capture the `save`
// calls so the test can inspect the inlineSettings the toggles produce.
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

import type { FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

// Find the inlineSettings object regardless of save()'s exact arg order.
function inlineSettingsFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings;
    }
  }
  return undefined;
}

describe('RemoteAccessTab — clipboard policy toggles', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('renders both clipboard direction toggles', () => {
    render(<RemoteAccessTab {...baseProps} />);
    expect(
      screen.getByText('Clipboard: remote → viewer (copy from remote)'),
    ).toBeTruthy();
    expect(
      screen.getByText('Clipboard: viewer → remote (paste to remote)'),
    ).toBeTruthy();
  });

  it('notes the host→viewer direction is the data-egress one', () => {
    render(<RemoteAccessTab {...baseProps} />);
    expect(screen.getByText(/data-egress direction/i)).toBeTruthy();
  });

  it('saves both clipboard fields with the rest of the settings', async () => {
    render(<RemoteAccessTab {...baseProps} />);

    // Turn OFF the egress direction so we can assert the value is wired through.
    const egressLabel = screen.getByText(
      'Clipboard: remote → viewer (copy from remote)',
    );
    const row = egressLabel.closest('div')?.parentElement as HTMLElement;
    const toggleButton = row.querySelector('button') as HTMLButtonElement;
    fireEvent.click(toggleButton);

    // Click the Save action (FeatureTabShell renders a Save button).
    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton);

    expect(saveMock).toHaveBeenCalled();
    const settings = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(settings).toBeDefined();
    expect(settings).toMatchObject({
      clipboardHostToViewer: false, // toggled off above
      clipboardViewerToHost: true, // default on
    });
  });
});

// #5080: Remote Access gains the same isInherited/effectiveLink/Override/
// Revert treatment as the other inline-settings tabs (mirrors PamTab.tsx).
describe('RemoteAccessTab inheritance (#5080)', () => {
  const onLinkChanged = vi.fn();
  const inheritedProps: FeatureTabProps = { ...baseProps, onLinkChanged };

  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
    onLinkChanged.mockClear();
  });

  function parentLinkWith(overrides: Record<string, unknown>) {
    return {
      id: 'link-parent',
      featureType: 'remote_access' as const,
      featurePolicyId: null,
      inlineSettings: { maxConcurrentTunnels: 5, ...overrides },
    };
  }

  it('shows Configured (inherited) and seeds the form from parentLink when only a parent link exists', () => {
    render(<RemoteAccessTab {...inheritedProps} parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })} />);

    expect(screen.getByText(/Configured \(inherited\)/i)).toBeTruthy();
    // maxConcurrentTunnels defaults to 5; the parent link's distinctive
    // override (12) must be reflected in the (read-only) field.
    expect((screen.getByDisplayValue('12') as HTMLInputElement).value).toBe('12');
  });

  it("Override saves a copy of the inherited settings as the policy's own link", () => {
    render(<RemoteAccessTab {...inheritedProps} parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })} />);

    fireEvent.click(screen.getByRole('button', { name: /override/i }));

    expect(saveMock).toHaveBeenCalled();
    const [existingId, payload] = saveMock.mock.calls[0] as unknown as [
      string | null,
      { featureType: string; featurePolicyId: string | null; inlineSettings: Record<string, unknown> },
    ];
    expect(existingId).toBeNull();
    expect(payload.featureType).toBe('remote_access');
    expect(payload.featurePolicyId).toBeNull();
    expect(payload.inlineSettings).toMatchObject({ maxConcurrentTunnels: 12 });
  });

  it('Revert to Parent removes the override', async () => {
    const existingLink = {
      id: 'link-own',
      featureType: 'remote_access' as const,
      featurePolicyId: null,
      inlineSettings: { maxConcurrentTunnels: 8 },
    };
    render(
      <RemoteAccessTab
        {...inheritedProps}
        existingLink={existingLink}
        parentLink={parentLinkWith({ maxConcurrentTunnels: 12 })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert to parent/i }));

    expect(removeMock).toHaveBeenCalledWith('link-own');
    // The detail page's own featureLinks state must be told the override is
    // gone (#5080) — otherwise it stays stale after a successful revert.
    await waitFor(() => expect(onLinkChanged).toHaveBeenCalledWith(null, 'remote_access'));
  });
});
