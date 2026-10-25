import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreatedAccountView, CredentialState } from '@breeze/shared';

const viewer = { id: 'user-approver' as string | null };
vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn(),
  useAuthStore: (sel: (s: { user: { id: string } | null }) => unknown) => sel({ user: viewer.id ? { id: viewer.id } : null }),
}));

import { fetchWithAuth } from '../../stores/auth';
import OperatorTaskAccounts from './OperatorTaskAccounts';

const fetchMock = vi.mocked(fetchWithAuth);
const APPROVER = 'user-approver';
const STARTER = 'user-starter';
const EXPIRES = '2026-11-01T12:00:00.000Z';

/** Decoys an API bug could leak alongside the view: neither may ever reach the DOM. */
const LEAKED_SECRET = 'Xy7Kp2mQ9wR4tZ8aB3cD';
const LEAKED_SEALED = 'enc:v3:QUJDREVGR0hJSktMTU5PUA==';

function account(state: CredentialState, overrides: Partial<CreatedAccountView> = {}): CreatedAccountView {
  const available = state === 'available';
  return {
    provider: 'm365',
    principalLabel: 'priya@customer.example',
    externalId: 'cccccccc-0000-4000-8000-000000000001',
    credentialState: state,
    intentId: state === 'not_applicable' ? null : 'intent-create-1',
    revealableByUserId: available ? APPROVER : null,
    revealableByName: available ? 'Alex Approver' : null,
    revealExpiresAt: available ? EXPIRES : null,
    // Not part of CreatedAccountView: an API that leaked these must still render nothing of them.
    ...({ temporaryPassword: LEAKED_SECRET, sealedResult: LEAKED_SEALED } as object),
    ...overrides,
  };
}

beforeEach(() => {
  viewer.id = APPROVER;
  fetchMock.mockReset();
});
afterEach(() => vi.clearAllMocks());

const TOKEN = /[A-Za-z0-9!#$%^&*+=/]{20,}/;

describe('OperatorTaskAccounts', () => {
  it.each<CredentialState>(['available', 'revealed', 'expired', 'unretrievable', 'not_applicable'])(
    '1. %s renders its own copy and nothing password-shaped',
    (state) => {
      const { container } = render(<OperatorTaskAccounts accounts={[account(state)]} />);
      const cell = screen.getByTestId('task-account-credential-m365');
      expect(cell).toHaveAttribute('data-state', state);
      const text = container.textContent ?? '';
      expect(text).not.toContain('enc:v3:');
      expect(text).not.toContain(LEAKED_SECRET);
      // Per text node: `textContent` glues adjacent elements into false tokens.
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) expect(n.textContent ?? '').not.toMatch(TOKEN);
      expect(container.innerHTML).not.toContain(LEAKED_SECRET);
      expect(container.innerHTML).not.toContain('enc:v3:');
    },
  );

  it('each state has distinct copy', () => {
    const copy = (['available', 'revealed', 'expired', 'unretrievable', 'not_applicable'] as const).map((s) => {
      const { unmount } = render(<OperatorTaskAccounts accounts={[account(s)]} />);
      const text = screen.getByTestId('task-account-credential-m365').textContent;
      unmount();
      return text;
    });
    expect(new Set(copy).size).toBe(5);
  });

  it('2a. available: the approver sees the reveal control', () => {
    viewer.id = APPROVER;
    render(<OperatorTaskAccounts accounts={[account('available')]} />);
    const cell = screen.getByTestId('task-account-credential-m365');
    expect(within(cell).getByTestId('task-account-reveal-m365')).toBeInTheDocument();
    expect(cell).toHaveTextContent('Temporary password available to Alex Approver until');
  });

  it('2b. available: anyone else (incl. the technician who started it) is told who to ask, with no control and no error styling', () => {
    viewer.id = STARTER;
    render(<OperatorTaskAccounts accounts={[account('available')]} />);
    const cell = screen.getByTestId('task-account-credential-m365');
    expect(within(cell).queryByTestId('task-account-reveal-m365')).toBeNull();
    expect(within(cell).queryByRole('link')).toBeNull();
    expect(within(cell).queryByRole('button')).toBeNull();
    expect(cell).toHaveTextContent('Ask Alex Approver to share the temporary password');
    expect(within(cell).queryByRole('alert')).toBeNull();
  });

  it('2c. no viewer (signed out mid-render): no control', () => {
    viewer.id = null;
    render(<OperatorTaskAccounts accounts={[account('available')]} />);
    expect(screen.queryByTestId('task-account-reveal-m365')).toBeNull();
  });

  it('3. the reveal control is a link into the AI activity feed, and clicking it makes no request', () => {
    render(<OperatorTaskAccounts accounts={[account('available')]} />);
    const link = screen.getByTestId('task-account-reveal-m365');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('/ai-risk');
    expect(link).toHaveAttribute('data-intent-id', 'intent-create-1');
    fireEvent.click(link);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('4. expired says to reset the password and not to create a second account', () => {
    render(<OperatorTaskAccounts accounts={[account('expired')]} />);
    const cell = screen.getByTestId('task-account-credential-m365');
    expect(cell).toHaveTextContent('Temporary password expired without being revealed');
    expect(cell).toHaveTextContent('Reset the password. Do not create a second account.');
  });

  it('4b. unretrievable says it was never stored, to reset, and not to create a second account', () => {
    render(<OperatorTaskAccounts accounts={[account('unretrievable')]} />);
    const cell = screen.getByTestId('task-account-credential-m365');
    expect(cell).toHaveTextContent('never stored');
    expect(cell).toHaveTextContent('Reset the password. Do not create a second account.');
    expect(within(cell).queryByRole('link')).toBeNull();
  });

  it('5. not_applicable renders without a control and without a date', () => {
    render(<OperatorTaskAccounts accounts={[account('not_applicable', { provider: 'google', principalLabel: 'priya@customer-mail.example', externalId: '1029384756' })]} />);
    const cell = screen.getByTestId('task-account-credential-google');
    expect(cell).toHaveTextContent('Password set by hand during onboarding');
    expect(within(cell).queryByRole('link')).toBeNull();
    expect(cell.textContent).not.toMatch(/\d{4}/);
  });

  it('revealed: no control', () => {
    render(<OperatorTaskAccounts accounts={[account('revealed')]} />);
    const cell = screen.getByTestId('task-account-credential-m365');
    expect(cell).toHaveTextContent('Temporary password already revealed');
    expect(within(cell).queryByRole('link')).toBeNull();
  });

  it('one row per account with provider, frozen principal and external id; states D-R2-6', () => {
    render(<OperatorTaskAccounts accounts={[
      account('available'),
      account('not_applicable', { provider: 'google', principalLabel: 'priya@customer-mail.example', externalId: '1029384756' }),
    ]} />);
    const m = screen.getByTestId('task-account-m365');
    expect(m).toHaveTextContent('Microsoft 365');
    expect(m).toHaveTextContent('priya@customer.example');
    expect(m).toHaveTextContent('cccccccc-0000-4000-8000-000000000001');
    expect(screen.getByTestId('task-account-google')).toHaveTextContent('Google Workspace');
    expect(screen.getByTestId('task-accounts-who-reveals')).toHaveTextContent('approved the account creation');
  });

  it('9. an empty accounts array renders nothing at all', () => {
    const { container } = render(<OperatorTaskAccounts accounts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
