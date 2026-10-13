import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import CallerVerifyCard from './CallerVerifyCard';
const token = 'A'.repeat(43);
const card = { status: 'pending', branding: { partnerName: 'Example MSP', logoUrl: null, accentColor: null, headline: null },
  contactFirstName: 'Alex', technicianLabel: 'Taylor', actionScope: 'reset_password', targetLabel: 'alex@example.com',
  reverseCode: '7291', choices: ['83','42','17'], expiresAt: new Date(Date.now()+600_000).toISOString() };
afterEach(() => vi.unstubAllGlobals());
it('names the exact request, preserves choices, and sends a generic confirmation', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(card))
    .mockResolvedValueOnce(Response.json({ status: 'received' }));
  vi.stubGlobal('fetch', fetch); render(<CallerVerifyCard token={token} />);
  expect(await screen.findByText('Taylor from Example MSP wants to:')).toBeTruthy();
  expect(screen.getByText('Reset the password for alex@example.com')).toBeTruthy();
  expect(screen.getByTestId('caller-verify-reverse').textContent).toContain('7 2 9 1');
  expect(screen.getAllByTestId('caller-verify-choice').map(el => el.textContent)).toEqual(['83','42','17']);
  await userEvent.click(screen.getAllByTestId('caller-verify-choice')[1]!);
  await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining(`/verify/${token}`),
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ choice: '42' }), credentials: 'omit' })));
  expect(await screen.findByTestId('caller-verify-received')).toBeTruthy();
  expect(screen.getByTestId('caller-verify-not-me')).toBeTruthy();
});
it('keeps late rejection usable on a generic expired page', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ status: 'expired' }))
    .mockResolvedValueOnce(Response.json({ status: 'received' }));
  vi.stubGlobal('fetch', fetch); render(<CallerVerifyCard token={token} />);
  await userEvent.click(await screen.findByTestId('caller-verify-not-me'));
  await waitFor(() => expect(fetch.mock.calls[1]?.[1].body).toBe(JSON.stringify({ choice: 'not_me' })));
});
it('exposes no challenge controls when the server flag is off', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: 'Not found' }, { status: 404 })));
  render(<CallerVerifyCard token={token} />);
  await screen.findByTestId('caller-verify-expired');
  expect(screen.queryByTestId('caller-verify-not-me')).toBeNull();
  expect(screen.queryAllByTestId('caller-verify-choice')).toHaveLength(0);
});
it('shows a failed mutation and leaves retry possible', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json(card))
    .mockRejectedValueOnce(new Error('offline')));
  render(<CallerVerifyCard token={token} />);
  await userEvent.click((await screen.findAllByTestId('caller-verify-choice'))[0]!);
  expect(await screen.findByTestId('caller-verify-error')).toBeTruthy();
  expect(screen.getAllByTestId('caller-verify-choice')[0]).not.toBeDisabled();
});
