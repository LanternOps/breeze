import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import RemoteAccessTab from './RemoteAccessTab';
import type { FeatureLink, FeatureTabProps } from './types';

// The picker is bounded to [1, 12] but stored policies predate that bound and
// can hold 0 ("unlimited") or anything up to 168. Those legacy values must be
// clamped as the component seeds/merges state — otherwise the select renders no
// matching option and an unrelated save is rejected by write-time validation on
// a field the operator never touched. Semantics mirror `clampSettings` in
// apps/api/src/services/remoteAccessPolicy.ts: <= 0, non-finite, or > 12 → 12.
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

const baseProps: FeatureTabProps = {
  policyId: 'policy-1',
  existingLink: undefined,
  linkedPolicyId: null,
  onLinkChanged: vi.fn(),
};

function linkWithDuration(hours: number): FeatureLink {
  return {
    id: 'link-1',
    featureType: 'remote_access',
    featurePolicyId: null,
    inlineSettings: { maxSessionDurationHours: hours },
  };
}

/**
 * The max-session-duration picker, identified by its exact option set so a
 * sibling `<select>` (idle timeout, prompt mode, identity level) can never be
 * picked up by accident and make an assertion vacuous.
 */
function maxSessionSelect(): HTMLSelectElement {
  const selects = Array.from(document.querySelectorAll('select'));
  const match = selects.find((s) => {
    const values = Array.from(s.options).map((o) => o.value);
    return values.join(',') === '1,2,4,8,12';
  });
  if (!match) throw new Error('max-session-duration select not found');
  return match as HTMLSelectElement;
}

function savedDuration(): unknown {
  const call = saveMock.mock.calls[0] as unknown[];
  for (const arg of call) {
    if (arg && typeof arg === 'object' && 'inlineSettings' in (arg as object)) {
      return (arg as { inlineSettings: Record<string, unknown> }).inlineSettings
        .maxSessionDurationHours;
    }
  }
  return undefined;
}

function clickSave(): void {
  const saveButton = screen
    .getAllByRole('button')
    .find((b) => /save/i.test(b.textContent ?? '')) as HTMLButtonElement;
  expect(saveButton).toBeTruthy();
  fireEvent.click(saveButton);
}

describe('RemoteAccessTab — legacy maxSessionDurationHours clamping', () => {
  beforeEach(() => {
    saveMock.mockClear();
    removeMock.mockClear();
  });

  it('clamps a stored 0 ("unlimited") to the 12 h cap on mount', () => {
    render(<RemoteAccessTab {...baseProps} existingLink={linkWithDuration(0)} />);

    // A value of 0 matches no option, so a controlled select would read ''.
    expect(maxSessionSelect().value).toBe('12');

    clickSave();
    expect(savedDuration()).toBe(12);
  });

  it('clamps a stored 24 down to the 12 h cap on mount', () => {
    render(<RemoteAccessTab {...baseProps} existingLink={linkWithDuration(24)} />);

    expect(maxSessionSelect().value).toBe('12');

    clickSave();
    expect(savedDuration()).toBe(12);
  });

  it('clamps a stored negative value to the 12 h cap on mount', () => {
    render(<RemoteAccessTab {...baseProps} existingLink={linkWithDuration(-4)} />);

    expect(maxSessionSelect().value).toBe('12');

    clickSave();
    expect(savedDuration()).toBe(12);
  });

  it('leaves an in-range stored value untouched', () => {
    render(<RemoteAccessTab {...baseProps} existingLink={linkWithDuration(4)} />);

    expect(maxSessionSelect().value).toBe('4');

    clickSave();
    expect(savedDuration()).toBe(4);
  });

  it('clamps on the effect-merge path when the link arrives after mount', () => {
    const { rerender } = render(<RemoteAccessTab {...baseProps} />);
    expect(maxSessionSelect().value).toBe('8'); // component default

    rerender(<RemoteAccessTab {...baseProps} existingLink={linkWithDuration(0)} />);
    expect(maxSessionSelect().value).toBe('12');

    clickSave();
    expect(savedDuration()).toBe(12);
  });

  it('clamps an out-of-range parent (inherited) value on the effect-merge path', () => {
    const { rerender } = render(<RemoteAccessTab {...baseProps} />);

    rerender(<RemoteAccessTab {...baseProps} parentLink={linkWithDuration(168)} />);
    expect(maxSessionSelect().value).toBe('12');
  });
});
