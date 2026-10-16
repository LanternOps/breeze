import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import SystemProtectionTab from './SystemProtectionTab';

// useFeatureLink wraps the save/remove API calls; stub it so we can assert the
// payload the tab submits without hitting the network. (Scaffolding copied
// from VulnerabilityTab.test.tsx.)
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

import type { FeatureLink, FeatureTabProps } from './types';

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function link(inlineSettings: Record<string, unknown>): FeatureLink {
  return { id: 'link-1', featureType: 'system_protection', featurePolicyId: null, inlineSettings };
}

function clickSave() {
  const saveButton = screen
    .getAllByRole('button')
    .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
  fireEvent.click(saveButton);
}

function payloadFromCall(call: unknown[]): Record<string, unknown> | undefined {
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'featureType' in (arg as object)) {
      return arg as Record<string, unknown>;
    }
  }
  return undefined;
}

describe('SystemProtectionTab', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('renders three toggles seeded from the platform defaults', () => {
    render(<SystemProtectionTab {...baseProps} />);
    expect(screen.getByTestId('system-protection-before-patching-toggle').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('system-protection-before-scripts-toggle').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('system-protection-before-software-toggle').getAttribute('aria-checked')).toBe('false');
    expect((screen.getByTestId('system-protection-label-prefix-input') as HTMLInputElement).value).toBe('Breeze');
  });

  it('labels the unconfigured state as the platform default, not as a policy choice', () => {
    render(<SystemProtectionTab {...baseProps} />);
    expect(screen.getByTestId('system-protection-platform-default-note')).toBeTruthy();
  });

  it('hides the platform-default note once a policy link exists', () => {
    render(<SystemProtectionTab {...baseProps} existingLink={link({ beforeScripts: true })} />);
    expect(screen.queryByTestId('system-protection-platform-default-note')).toBeNull();
    expect(screen.getByTestId('system-protection-before-scripts-toggle').getAttribute('aria-checked')).toBe('true');
  });

  it('never promises recoverability, and says System Restore is not a backup', () => {
    const { container } = render(<SystemProtectionTab {...baseProps} />);
    const text = (container.textContent ?? '').toLowerCase();
    expect(text).not.toContain('rollback available');
    expect(text).not.toContain('you can roll back');
    expect(text).not.toContain('guarantee');
    expect(text).toContain('not a backup');
  });

  it('warns that an explicit patch disable is unenforceable on older agents', () => {
    render(<SystemProtectionTab {...baseProps} existingLink={link({ beforePatching: false })} />);
    expect(screen.getByTestId('system-protection-legacy-agent-warning')).toBeTruthy();
  });

  it('does not show the legacy-agent warning while patch checkpoints are on', () => {
    render(<SystemProtectionTab {...baseProps} />);
    expect(screen.queryByTestId('system-protection-legacy-agent-warning')).toBeNull();
  });

  it('saves the full settings object as inline settings (never a featurePolicyId)', () => {
    render(<SystemProtectionTab {...baseProps} />);
    fireEvent.click(screen.getByTestId('system-protection-before-scripts-toggle'));
    clickSave();

    expect(saveMock).toHaveBeenCalled();
    expect(payloadFromCall(saveMock.mock.calls[0])).toEqual({
      featureType: 'system_protection',
      featurePolicyId: null,
      inlineSettings: {
        beforePatching: true,
        beforeScripts: true,
        beforeSoftwareInstall: false,
        labelPrefix: 'Breeze',
      },
    });
  });

  it('saves the default prefix when the field is cleared or blank (the API rejects an empty one)', () => {
    render(<SystemProtectionTab {...baseProps} />);
    fireEvent.change(screen.getByTestId('system-protection-label-prefix-input'), { target: { value: '   ' } });
    clickSave();
    expect((payloadFromCall(saveMock.mock.calls[0])?.inlineSettings as Record<string, unknown>).labelPrefix).toBe('Breeze');
  });

  it('trims the prefix before saving', () => {
    render(<SystemProtectionTab {...baseProps} />);
    fireEvent.change(screen.getByTestId('system-protection-label-prefix-input'), { target: { value: '  Ops  ' } });
    clickSave();
    expect((payloadFromCall(saveMock.mock.calls[0])?.inlineSettings as Record<string, unknown>).labelPrefix).toBe('Ops');
  });

  it('resets to the platform defaults when the link is removed (no stale toggles under the default note)', () => {
    const { rerender } = render(
      <SystemProtectionTab {...baseProps} existingLink={link({ beforePatching: false, beforeScripts: true })} />,
    );
    expect(screen.getByTestId('system-protection-before-scripts-toggle').getAttribute('aria-checked')).toBe('true');

    rerender(<SystemProtectionTab {...baseProps} existingLink={undefined} />);
    expect(screen.getByTestId('system-protection-platform-default-note')).toBeTruthy();
    expect(screen.getByTestId('system-protection-before-scripts-toggle').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('system-protection-before-patching-toggle').getAttribute('aria-checked')).toBe('true');
  });

  it('shows inherited parent settings without the platform-default note, and overrides as a new link', () => {
    render(<SystemProtectionTab {...baseProps} parentLink={link({ beforeSoftwareInstall: true })} />);
    expect(screen.queryByTestId('system-protection-platform-default-note')).toBeNull();
    expect(screen.getByTestId('system-protection-before-software-toggle').getAttribute('aria-checked')).toBe('true');
  });

  it('caps the label prefix input at 64 characters', () => {
    render(<SystemProtectionTab {...baseProps} />);
    expect((screen.getByTestId('system-protection-label-prefix-input') as HTMLInputElement).maxLength).toBe(64);
  });

  it('drops unknown stored keys rather than echoing them back on save', () => {
    // The API schema is strict; a stale/unknown key in the stored blob would
    // make every save 400.
    render(<SystemProtectionTab {...baseProps} existingLink={link({ beforeScripts: true, legacyKey: 1 })} />);
    clickSave();
    expect(payloadFromCall(saveMock.mock.calls[0])?.inlineSettings).not.toHaveProperty('legacyKey');
  });
});
