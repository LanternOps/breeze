import '@/lib/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallerVerificationEntry } from './CallerVerificationEntry';
import { ORG, CONTACT } from './testFixtures';

const enabled = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/useCallerVerificationEnabled', () => ({ useCallerVerificationEnabled: () => enabled.value }));
vi.mock('./VerifyCallerModal', () => ({
  VerifyCallerModal: (p: { orgId: string; initialContactId?: string; onClose: () => void }) => (
    <div data-testid="modal" data-org={p.orgId} data-contact={p.initialContactId}><button onClick={p.onClose}>x</button></div>
  ),
}));
afterEach(() => { enabled.value = false; window.location.hash = ''; });

it('does not mount even when the verification hash is forged while disabled', () => {
  window.location.hash = 'caller-verification';
  render(<CallerVerificationEntry orgId={ORG} hash="caller-verification" />);
  expect(screen.queryByTestId('cv-entry')).toBeNull();
  expect(screen.queryByTestId('modal')).toBeNull();
});

it('opens via the hash, passes its props through and restores the previous hash on close', async () => {
  enabled.value = true;
  window.location.hash = 'activity';
  render(<CallerVerificationEntry orgId={ORG} initialContactId={CONTACT} lockContact hash="caller-verification" />);
  fireEvent.click(screen.getByTestId('cv-entry'));
  expect(window.location.hash).toBe('#caller-verification');
  expect(screen.getByTestId('modal')).toHaveAttribute('data-contact', CONTACT);
  await act(async () => { fireEvent.click(screen.getByText('x')); });
  expect(screen.queryByTestId('modal')).toBeNull();
  expect(window.location.hash).toBe('#activity');
});

it('opens directly from a deep-linked hash when enabled', () => {
  enabled.value = true;
  window.location.hash = 'caller-verification';
  render(<CallerVerificationEntry orgId={ORG} hash="caller-verification" />);
  expect(screen.getByTestId('modal')).toHaveAttribute('data-org', ORG);
});
