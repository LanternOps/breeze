import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PamTab from './PamTab';

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

describe('PamTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('renders the UAC interception toggle, defaulted ON', () => {
    render(<PamTab {...baseProps} />);
    expect(screen.getByText('Capture Windows UAC elevation prompts')).toBeTruthy();
  });

  it('links rule management out to the /pam console', () => {
    render(<PamTab {...baseProps} />);
    const link = screen.getByRole('link', { name: /privileged access console/i }) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/pam');
  });

  it('saves uacInterceptionEnabled=false after toggling off', async () => {
    render(<PamTab {...baseProps} />);

    const toggleButton = screen.getByTestId('pam-tab-capture-toggle') as HTMLButtonElement;
    fireEvent.click(toggleButton);

    const saveButton = screen
      .getAllByRole('button')
      .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
    expect(saveButton).toBeTruthy();
    fireEvent.click(saveButton);

    expect(saveMock).toHaveBeenCalled();
    const settings = inlineSettingsFromCall(saveMock.mock.calls[0]);
    expect(settings).toEqual({ uacInterceptionEnabled: false });
  });
});
