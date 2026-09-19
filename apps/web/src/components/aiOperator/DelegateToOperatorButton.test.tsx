import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../lib/i18n';

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock('../shared/Toast', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, showToast: (...args: unknown[]) => showToast(...args) };
});
vi.mock('@/lib/navigation', () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));

let gateEnabled = true;
vi.mock('../../stores/featuresStore', () => ({
  useAiOperatorTasksGate: () => ({ enabled: gateEnabled, loaded: true }),
}));

import { DelegateToOperatorButton } from './DelegateToOperatorButton';

const okJson = (payload: unknown): Response =>
  ({ ok: true, status: 200, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const errJson = (status: number, payload: unknown): Response =>
  ({ ok: false, status, json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const BASE_PROPS = {
  orgId: 'org-1',
  deviceId: 'device-1',
  deviceLabel: 'WKS-01',
  orgLabel: 'Acme Corp',
  source: { kind: 'alert' as const, id: 'alert-1' },
};

beforeEach(() => {
  gateEnabled = true;
  fetchWithAuth.mockReset();
  showToast.mockReset();
  navigateTo.mockReset();
});

describe('DelegateToOperatorButton', () => {
  it('renders nothing when the gate is disabled', () => {
    gateEnabled = false;
    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    expect(screen.queryByTestId('delegate-to-operator')).toBeNull();
  });

  it('renders the button when the gate is enabled', () => {
    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    expect(screen.getByTestId('delegate-to-operator')).toBeInTheDocument();
  });

  it('prefills the service input from defaultServiceName', async () => {
    render(<DelegateToOperatorButton {...BASE_PROPS} defaultServiceName="spooler" />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');
    expect(input).toHaveValue('spooler');
  });

  it('disables confirm and shows an error when the service name is cleared', async () => {
    render(<DelegateToOperatorButton {...BASE_PROPS} defaultServiceName="spooler" />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');

    // No error before any interaction.
    expect(screen.queryByTestId('delegate-to-operator-error')).toBeNull();

    await userEvent.clear(input);
    await userEvent.tab(); // blur the empty field

    expect(screen.getByTestId('delegate-to-operator-error')).toBeInTheDocument();
    expect(screen.getByTestId('delegate-to-operator-confirm')).toHaveAttribute('aria-disabled', 'true');
  });

  it('happy path: submits and matches the expected body', async () => {
    fetchWithAuth.mockResolvedValue(okJson({ taskId: 'task-99' }));

    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');
    await userEvent.type(input, 'spooler');
    await userEvent.click(screen.getByTestId('delegate-to-operator-confirm'));

    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    const [url, init] = fetchWithAuth.mock.calls[0];
    expect(url).toBe('/ai/operator/tasks');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      mode: 'live',
      recipeKey: 'service_recovery',
      recipeVersion: 1,
      orgId: 'org-1',
      deviceId: 'device-1',
      inputs: { serviceName: 'spooler' },
      sourceKind: 'alert',
      sourceId: 'alert-1',
    });
    expect(typeof body.clientIdempotencyKey).toBe('string');
    expect(body.clientIdempotencyKey.length).toBeGreaterThan(0);
  });

  it('keeps the idempotency key stable across two confirms of the same opened dialog', async () => {
    fetchWithAuth
      .mockResolvedValueOnce(errJson(500, { error: 'boom' }))
      .mockResolvedValueOnce(okJson({ taskId: 'task-1' }));

    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');
    await userEvent.type(input, 'spooler');

    // First confirm fails.
    await userEvent.click(screen.getByTestId('delegate-to-operator-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));

    // Second confirm on the SAME still-open dialog.
    await userEvent.click(screen.getByTestId('delegate-to-operator-confirm'));
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledTimes(2));

    const firstBody = JSON.parse(fetchWithAuth.mock.calls[0][1].body as string);
    const secondBody = JSON.parse(fetchWithAuth.mock.calls[1][1].body as string);
    expect(secondBody.clientIdempotencyKey).toBe(firstBody.clientIdempotencyKey);
  });

  it('failure path shows an error toast', async () => {
    fetchWithAuth.mockResolvedValue(errJson(500, { error: 'boom' }));

    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');
    await userEvent.type(input, 'spooler');
    await userEvent.click(screen.getByTestId('delegate-to-operator-confirm'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    ));
  });

  it('navigates to the new task on success', async () => {
    fetchWithAuth.mockResolvedValue(okJson({ taskId: 'task-42' }));

    render(<DelegateToOperatorButton {...BASE_PROPS} />);
    await userEvent.click(screen.getByTestId('delegate-to-operator'));

    const input = await screen.findByTestId('delegate-to-operator-service');
    await userEvent.type(input, 'spooler');
    await userEvent.click(screen.getByTestId('delegate-to-operator-confirm'));

    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith('/operator/tasks/task-42'));
  });
});
