import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { OutlookAuthExtras } from './OutlookAuthExtras';
import * as core from '@breeze/office-addin-core';
import * as api from './api';

vi.mock('@breeze/office-addin-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@breeze/office-addin-core')>();
  return {
    ...actual,
    getEntraTokenSilent: vi.fn(async () => 'entra-tok'),
    getEntraTokenInteractive: vi.fn(async () => 'entra-tok'),
    signIn: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openAndBind(): Promise<void> {
  fireEvent.click(screen.getByTestId('technician-signin-link'));
  await waitFor(() => expect(screen.getByTestId('bind-email')).toBeTruthy());
  fireEvent.change(screen.getByTestId('bind-email'), { target: { value: 'tech@partner.example' } });
  fireEvent.change(screen.getByTestId('bind-password'), { target: { value: 'hunter2' } });
  fireEvent.change(screen.getByTestId('bind-mfa'), { target: { value: '123456' } });
  fireEvent.click(screen.getByTestId('bind-submit'));
}

describe('OutlookAuthExtras', () => {
  it('starts as a low-key "Technician sign-in" link, not the bind form', async () => {
    render(<OutlookAuthExtras onSessionReady={vi.fn()} />);
    expect(screen.getByTestId('technician-signin-link')).toBeTruthy();
    expect(screen.queryByTestId('bind-email')).toBeNull();
  });

  it('opens BindFlow on click, and on successful bind fires a fresh silent signIn against the office-addin exchange path, then onSessionReady', async () => {
    vi.spyOn(api, 'bindTechnician').mockResolvedValue({ bound: true });
    const signInMock = core.signIn as unknown as ReturnType<typeof vi.fn>;
    signInMock.mockResolvedValue({
      v: 2,
      persona: 'tech',
      sessionToken: 'tech-tok',
      expiresAt: Date.now() + 60_000,
      user: { id: 'u-1', email: 'tech@partner.example', name: 'Tech' },
      partner: { id: 'p-1' },
    });
    const onSessionReady = vi.fn();

    render(<OutlookAuthExtras onSessionReady={onSessionReady} />);
    await openAndBind();

    await waitFor(() => expect(onSessionReady).toHaveBeenCalledTimes(1));
    expect(signInMock).toHaveBeenCalledWith({
      interactive: false,
      exchangePath: '/office-addin/auth/exchange',
    });
  });

  it('falls back to the closed link with an error if the post-bind re-signIn fails, without calling onSessionReady', async () => {
    vi.spyOn(api, 'bindTechnician').mockResolvedValue({ bound: true });
    const signInMock = core.signIn as unknown as ReturnType<typeof vi.fn>;
    signInMock.mockRejectedValue(new Error('exchange down'));
    const onSessionReady = vi.fn();

    render(<OutlookAuthExtras onSessionReady={onSessionReady} />);
    await openAndBind();

    await waitFor(() => expect(screen.getByTestId('technician-resignin-error')).toBeTruthy());
    expect(onSessionReady).not.toHaveBeenCalled();
    expect(screen.getByTestId('technician-signin-link')).toBeTruthy();
  });
});
