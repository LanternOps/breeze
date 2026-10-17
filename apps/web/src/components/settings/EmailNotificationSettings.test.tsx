import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailNotificationSettings from './EmailNotificationSettings';

const mocks = vi.hoisted(() => ({ fetchWithAuth: vi.fn(), showToast: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: mocks.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: mocks.showToast }));

const res = (body: unknown, ok = true, status = ok ? 200 : 500) => ({
  ok,
  status,
  statusText: ok ? 'OK' : 'ERROR',
  json: async () => body,
  text: async () => JSON.stringify(body),
});

const toggle = () => screen.getByTestId('email-digest-toggle') as HTMLInputElement;

beforeEach(() => {
  mocks.fetchWithAuth.mockReset();
  mocks.showToast.mockReset();
});

describe('EmailNotificationSettings', () => {
  it('renders checked when subscribed', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res({ connectionHealthDigest: true }));
    render(<EmailNotificationSettings />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(true);
    expect(mocks.fetchWithAuth).toHaveBeenCalledWith('/users/me/email-preferences');
  });

  it('renders unchecked when unsubscribed', async () => {
    mocks.fetchWithAuth.mockResolvedValueOnce(res({ connectionHealthDigest: false }));
    render(<EmailNotificationSettings />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
  });

  it('PATCHes the new value and shows the new state', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res({ connectionHealthDigest: true }))
      .mockResolvedValueOnce(res({ connectionHealthDigest: false }));
    render(<EmailNotificationSettings />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    await userEvent.click(toggle());
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2));
    const [url, init] = mocks.fetchWithAuth.mock.calls[1]!;
    expect(url).toBe('/users/me/email-preferences');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ connectionHealthDigest: false });
    await waitFor(() => expect(toggle().checked).toBe(false));
  });

  it('reverts the toggle when the PATCH fails', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res({ connectionHealthDigest: true }))
      .mockResolvedValueOnce(res({ error: 'boom' }, false, 500));
    render(<EmailNotificationSettings />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    await userEvent.click(toggle());
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle().checked).toBe(true));
    await waitFor(() => expect(toggle().disabled).toBe(false));
  });

  it('shows a load error and retry reloads', async () => {
    mocks.fetchWithAuth
      .mockResolvedValueOnce(res({}, false, 500))
      .mockResolvedValueOnce(res({ connectionHealthDigest: false }));
    render(<EmailNotificationSettings />);
    const retry = await screen.findByRole('button', { name: /retry/i });
    expect(screen.getByRole('alert')).toBeTruthy();
    await userEvent.click(retry);
    await waitFor(() => expect(mocks.fetchWithAuth).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
