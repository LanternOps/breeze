import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BindFlow } from './BindFlow';
import * as api from './api';
import { TechApiError } from './api';

vi.mock('@breeze/office-addin-core', () => ({
  getEntraTokenSilent: vi.fn(async () => 'entra-tok'),
  getEntraTokenInteractive: vi.fn(async () => 'entra-tok'),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function waitForFormReady(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('bind-email')).toBeTruthy());
}

describe('BindFlow', () => {
  it('keeps submit disabled until email, password, and MFA code are all filled', async () => {
    render(<BindFlow onBound={vi.fn()} />);
    await waitForFormReady();

    const submit = screen.getByTestId('bind-submit') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('bind-email'), { target: { value: 'tech@partner.example' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('bind-password'), { target: { value: 'hunter2' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('bind-mfa'), { target: { value: '123456' } });
    expect(submit.disabled).toBe(false);
  });

  it('surfaces invalid_mfa inline without calling onBound', async () => {
    vi.spyOn(api, 'bindTechnician').mockRejectedValue(new TechApiError(401, 'invalid_mfa'));
    const onBound = vi.fn();
    render(<BindFlow onBound={onBound} />);
    await waitForFormReady();

    fireEvent.change(screen.getByTestId('bind-email'), { target: { value: 'tech@partner.example' } });
    fireEvent.change(screen.getByTestId('bind-password'), { target: { value: 'hunter2' } });
    fireEvent.change(screen.getByTestId('bind-mfa'), { target: { value: '000000' } });
    fireEvent.click(screen.getByTestId('bind-submit'));

    await waitFor(() => expect(screen.getByTestId('bind-error')).toBeTruthy());
    expect(screen.getByTestId('bind-error').textContent).toMatch(/verification code/i);
    expect(onBound).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_credentials', 401, /email or password/i],
    ['not_a_technician', 403, /technician account/i],
    ['mfa_enrollment_required', 403, /multi-factor/i],
    ['identity_already_bound', 409, /already linked/i],
  ])('surfaces %s inline', async (code, status, pattern) => {
    vi.spyOn(api, 'bindTechnician').mockRejectedValue(new TechApiError(status, code));
    render(<BindFlow onBound={vi.fn()} />);
    await waitForFormReady();

    fireEvent.change(screen.getByTestId('bind-email'), { target: { value: 'tech@partner.example' } });
    fireEvent.change(screen.getByTestId('bind-password'), { target: { value: 'hunter2' } });
    fireEvent.change(screen.getByTestId('bind-mfa'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('bind-submit'));

    await waitFor(() => expect(screen.getByTestId('bind-error')).toBeTruthy());
    expect(screen.getByTestId('bind-error').textContent).toMatch(pattern);
  });

  it('calls bindTechnician with the acquired Entra token and form fields, then onBound on success', async () => {
    vi.spyOn(api, 'bindTechnician').mockResolvedValue({ bound: true });
    const onBound = vi.fn();
    render(<BindFlow onBound={onBound} />);
    await waitForFormReady();

    fireEvent.change(screen.getByTestId('bind-email'), { target: { value: 'tech@partner.example' } });
    fireEvent.change(screen.getByTestId('bind-password'), { target: { value: 'hunter2' } });
    fireEvent.change(screen.getByTestId('bind-mfa'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('bind-submit'));

    await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1));
    expect(api.bindTechnician).toHaveBeenCalledWith({
      accessToken: 'entra-tok',
      email: 'tech@partner.example',
      password: 'hunter2',
      mfaCode: '123456',
    });
    expect(screen.queryByTestId('bind-error')).toBeNull();
  });
});
