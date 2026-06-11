import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
