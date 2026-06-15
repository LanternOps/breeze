import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the five tab islands — each has its own test file; here we only test
// the hash routing shell.
vi.mock('./OrgsTab', () => ({
  default: ({ onOpenPolicy }: { onOpenPolicy: (id: string) => void }) => (
    <button data-testid="stub-orgs" onClick={() => onOpenPolicy('ORG-1')}>
      orgs
    </button>
  ),
}));
vi.mock('./PolicyEditor', () => ({
  default: ({ orgId, onBack }: { orgId: string; onBack: () => void }) => (
    <div data-testid="stub-policy">
      <span data-testid="stub-policy-org">{orgId}</span>
      <button data-testid="stub-policy-back" onClick={onBack}>
        back
      </button>
    </div>
  ),
}));
vi.mock('./SessionsTab', () => ({ default: () => <div data-testid="stub-sessions" /> }));
vi.mock('./UsageTab', () => ({ default: () => <div data-testid="stub-usage" /> }));
vi.mock('./TemplatesTab', () => ({ default: () => <div data-testid="stub-templates" /> }));

import AiForOfficePage, { getStateFromHash } from './AiForOfficePage';

describe('AiForOfficePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/ai-for-office');
  });

  it('defaults to the orgs tab', () => {
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-orgs')).toBeInTheDocument();
  });

  it('reads the initial tab from the hash', () => {
    window.location.hash = '#sessions';
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-sessions')).toBeInTheDocument();
  });

  it('switches tabs on click and writes the hash', () => {
    render(<AiForOfficePage />);
    fireEvent.click(screen.getByTestId('ai-office-tab-usage'));
    expect(screen.getByTestId('stub-usage')).toBeInTheDocument();
    expect(window.location.hash).toBe('#usage');
    fireEvent.click(screen.getByTestId('ai-office-tab-templates'));
    expect(screen.getByTestId('stub-templates')).toBeInTheDocument();
    expect(window.location.hash).toBe('#templates');
  });

  it('routes #policy/<orgId> deep links to the policy editor', () => {
    window.location.hash = '#policy/ORG-9';
    render(<AiForOfficePage />);
    expect(screen.getByTestId('stub-policy-org').textContent).toBe('ORG-9');
  });

  it('OrgsTab → policy editor → back round-trip updates the hash', () => {
    render(<AiForOfficePage />);
    fireEvent.click(screen.getByTestId('stub-orgs')); // calls onOpenPolicy('ORG-1')
    expect(screen.getByTestId('stub-policy-org').textContent).toBe('ORG-1');
    expect(window.location.hash).toBe('#policy/ORG-1');
    fireEvent.click(screen.getByTestId('stub-policy-back'));
    expect(screen.getByTestId('stub-orgs')).toBeInTheDocument();
    expect(window.location.hash).toBe('#orgs');
  });

  it('getStateFromHash falls back to orgs for junk hashes', () => {
    window.location.hash = '#nonsense';
    expect(getStateFromHash()).toEqual({ tab: 'orgs' });
    window.location.hash = '#policy/';
    expect(getStateFromHash()).toEqual({ tab: 'orgs' });
  });
});
