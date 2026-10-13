import '@/lib/i18n';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as api from '@/lib/api/callerVerification';
import { useAuthStore } from '@/stores/auth';
import { ActionError } from '@/lib/runAction';
import { VerifyCallerModal } from './VerifyCallerModal';
import { ORG, CONTACT, TARGET, TICKET, USER, row, methods } from './testFixtures';

vi.mock('@/lib/api/callerVerification', async (orig) => ({
  ...(await orig<typeof import('@/lib/api/callerVerification')>()),
  contactsPage: vi.fn(), methodsForContact: vi.fn(), startVerification: vi.fn(),
  getVerification: vi.fn(), cancelVerification: vi.fn(), attestVerification: vi.fn(),
}));

beforeEach(() => {
  useAuthStore.setState({ user: { id: USER, email: 't@example.test', name: 'Tech' } as never });
  vi.mocked(api.contactsPage).mockResolvedValue({ data: [
    { id: CONTACT, name: 'Ada', email: 'ada@example.test', phone: null, siteId: null },
    { id: TARGET, name: 'Grace', email: null, phone: null, siteId: null },
  ], total: 2 });
  vi.mocked(api.methodsForContact).mockResolvedValue(methods);
  vi.mocked(api.startVerification).mockResolvedValue(row);
  vi.mocked(api.getVerification).mockResolvedValue(row);
  vi.mocked(api.cancelVerification).mockResolvedValue({ ...row, status: 'cancelled' });
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('lists server methods, hides an unavailable workstation, and explains other unavailable methods', async () => {
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} />);
  await screen.findByTestId('cv-method-sms');
  expect(screen.queryByTestId('cv-method-workstation')).toBeNull();
  expect(screen.getByTestId('cv-method-email')).toBeDisabled();
  expect(screen.getByText('No established contact detail on file')).toBeVisible();
  expect(screen.getByTestId('cv-method-callback_attestation')).toBeEnabled();
  expect(api.methodsForContact).toHaveBeenCalledWith(ORG, CONTACT, 'any', expect.any(AbortSignal));
  expect(api.contactsPage).not.toHaveBeenCalled();
});

it('re-reads methods for the chosen action and starts with the exact body', async () => {
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact ticketId={TICKET} onClose={vi.fn()} />);
  await screen.findByTestId('cv-method-sms');
  fireEvent.change(screen.getByTestId('cv-action'), { target: { value: 'reset_password' } });
  await waitFor(() => expect(api.methodsForContact).toHaveBeenLastCalledWith(ORG, CONTACT, 'reset_password', expect.any(AbortSignal)));
  expect(screen.getByTestId('cv-start')).toBeDisabled();
  fireEvent.click(await screen.findByTestId('cv-method-sms'));
  await act(async () => { fireEvent.click(screen.getByTestId('cv-start')); });
  expect(api.startVerification).toHaveBeenCalledWith({ orgId: ORG, contactId: CONTACT, actionScope: 'reset_password', method: 'sms', ticketId: TICKET });
  expect(screen.getByTestId('cv-match')).toHaveTextContent('42');
});

it('picks a requester from the org contact list when none is given', async () => {
  render(<VerifyCallerModal orgId={ORG} onClose={vi.fn()} />);
  const picker = await screen.findByTestId('cv-contact');
  expect(api.methodsForContact).not.toHaveBeenCalled();
  await waitFor(() => expect(picker.querySelectorAll('option').length).toBe(3));
  fireEvent.change(picker, { target: { value: TARGET } });
  await waitFor(() => expect(api.methodsForContact).toHaveBeenCalledWith(ORG, TARGET, 'any', expect.any(AbortSignal)));
});

it('cancels a pending verification and offers another attempt', async () => {
  const onChanged = vi.fn();
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} onChanged={onChanged} />);
  fireEvent.click(await screen.findByTestId('cv-method-sms'));
  await act(async () => { fireEvent.click(screen.getByTestId('cv-start')); });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-cancel')); });
  expect(api.cancelVerification).toHaveBeenCalledWith(ORG, row.id);
  expect(screen.getByText('This verification was cancelled.')).toBeVisible();
  expect(onChanged).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'cancelled' }));
  fireEvent.click(screen.getByTestId('cv-again'));
  expect(await screen.findByTestId('cv-start')).toBeInTheDocument();
});

it('records a callback attestation only with a 20-character note', async () => {
  const callback = { ...row, method: 'callback_attestation' as const, secrets: undefined, destinationRedacted: null };
  vi.mocked(api.startVerification).mockResolvedValue(callback);
  vi.mocked(api.attestVerification).mockResolvedValue({ ...callback, status: 'verified', decidedAt: new Date().toISOString(), usableUntil: new Date(Date.now() + 1800000).toISOString() });
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} />);
  fireEvent.click(await screen.findByTestId('cv-method-callback_attestation'));
  await act(async () => { fireEvent.click(screen.getByTestId('cv-start')); });
  const note = screen.getByTestId('cv-attest-note');
  fireEvent.change(note, { target: { value: 'too short' } });
  expect(screen.getByTestId('cv-attest')).toBeDisabled();
  fireEvent.change(note, { target: { value: 'Called the mobile on file and confirmed the request' } });
  await act(async () => { fireEvent.click(screen.getByTestId('cv-attest')); });
  expect(api.attestVerification).toHaveBeenCalledWith(ORG, row.id, 'Called the mobile on file and confirmed the request');
  expect(screen.getByText('Verified')).toBeVisible();
});

it('keeps the start form usable after a refused start', async () => {
  vi.mocked(api.startVerification).mockRejectedValue(new ActionError('Rate limited', 429));
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} />);
  fireEvent.click(await screen.findByTestId('cv-method-sms'));
  await act(async () => { fireEvent.click(screen.getByTestId('cv-start')); });
  expect(screen.getByTestId('cv-start')).toBeEnabled();
  expect(screen.queryByTestId('cv-status')).toBeNull();
});

it('offers an available workstation only when the mount can supply device context', async () => {
  vi.mocked(api.methodsForContact).mockResolvedValue(methods.map((m) => (m.method === 'workstation' ? { ...m, available: true, unavailableReason: undefined } : m)));
  const view = render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} />);
  await screen.findByTestId('cv-method-sms');
  expect(screen.queryByTestId('cv-method-workstation')).toBeNull();
  view.unmount();
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact workstation={{ deviceId: TARGET, username: 'ada' }} onClose={vi.fn()} />);
  fireEvent.click(await screen.findByTestId('cv-method-workstation'));
  await act(async () => { fireEvent.click(screen.getByTestId('cv-start')); });
  expect(api.startVerification).toHaveBeenCalledWith({ orgId: ORG, contactId: CONTACT, actionScope: 'any', method: 'workstation', deviceId: TARGET, username: 'ada' });
});

it('shows a method-load failure instead of an empty list', async () => {
  vi.mocked(api.methodsForContact).mockRejectedValue(new Error('boom'));
  render(<VerifyCallerModal orgId={ORG} initialContactId={CONTACT} lockContact onClose={vi.fn()} />);
  expect(await screen.findByText('Could not load verification methods.')).toBeVisible();
});
