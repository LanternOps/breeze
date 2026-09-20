import '@/lib/i18n';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EscalationPolicyDrawer from './EscalationPolicyDrawer';
import type { EditableEscalationPolicy } from './deliveryActions';

vi.mock('../../../stores/auth', () => ({ fetchWithAuth: vi.fn() }));
import { fetchWithAuth } from '../../../stores/auth';
const validStep = { delayMinutes: 5, channelIds: ['ch'], userIds: [] };
function mount(steps: unknown = [validStep]) {
  const onSave = vi.fn();
  render(<EscalationPolicyDrawer open policy={{ id: 'ep', name: 'On-call', orgId: 'org', partnerId: null, steps } as EditableEscalationPolicy}
    channels={[{ id: 'ch', name: 'Email', type: 'email', enabled: true }]} orgId="org" ownerScope="organization" showOwnerScope={false}
    saving={false} onSave={onSave} onCancel={() => {}} />);
  return onSave;
}
beforeEach(() => {
  vi.mocked(fetchWithAuth).mockResolvedValue({ ok: true, json: async () => ({ data: [] }) } as Response);
});
describe('legacy escalation steps (G1)', () => {
  it.each([
    ['missing channels', [{ delayMinutes: 5, userIds: ['user'] }], 5],
    ['null steps', null, 15],
    ['extra keys and string delay', [{ delayMinutes: '5', channelIds: ['ch'], extra: true }], 5],
    ['invalid arrays and repeat', [{ delayMinutes: 'bad', channelIds: 7, userIds: [3, 'user'], repeat: { everyMinutes: 5, maxTimes: 'bad' } }], 15],
    ['non-array steps', { length: 1 }, 15],
    ['null step', [null], 15],
  ])('repairs %s and tells the user', async (_, steps, delay) => {
    mount(steps);
    expect(screen.getByTestId('escalation-step-0-delay')).toHaveValue(delay);
    expect(screen.getByTestId('escalation-legacy-repaired')).toHaveTextContent('stored policy');
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalled());
  });
  it('strips extra fields from the saved step', async () => {
    const onSave = mount([{ ...validStep, delayMinutes: '5', extra: true }]);
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
    fireEvent.click(screen.getByTestId('escalation-policy-drawer-save'));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ steps: [validStep] }));
  });
  it('does not show a notice for well-formed steps', async () => {
    mount();
    expect(screen.queryByTestId('escalation-legacy-repaired')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
  });
});

describe('inline escalation validation (G4)', () => {
  it.each([
    ['delay', 0, 'Enter a whole number from 1–1440 minutes.'],
    ['delay', 1441, 'Enter a whole number from 1–1440 minutes.'],
    ['every', 2000, 'Enter a whole number from 1–1440 minutes.'],
    ['times', 11, 'Enter a whole number from 1–10 times.'],
  ])('explains invalid %s=%s and clears when fixed', async (field, value, message) => {
    mount([{ ...validStep, repeat: { everyMinutes: 15, maxTimes: 1 } }]);
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
    const input = screen.getByTestId(`escalation-step-0-${field}`);
    fireEvent.change(input, { target: { value } });
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(document.getElementById(input.getAttribute('aria-describedby')!)).toHaveTextContent(message);
    fireEvent.change(input, { target: { value: 5 } });
    expect(screen.queryByText(message)).toBeNull();
    expect(input).not.toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled();
  });
  it('explains a missing target and clears when fixed', async () => {
    mount([{ ...validStep, channelIds: [] }]);
    expect(screen.getByText('Select at least one channel or user per step.')).toBeInTheDocument();
    expect(screen.getByTestId('escalation-step-0-channel-ch')).toHaveAttribute('aria-invalid', 'true');
    fireEvent.click(screen.getByTestId('escalation-step-0-channel-ch'));
    expect(screen.queryByText('Select at least one channel or user per step.')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
  });
  it('explains the policy notification limit and clears when fixed', async () => {
    mount(Array.from({ length: 5 }, () => ({ ...validStep, repeat: { everyMinutes: 15, maxTimes: 10 } })));
    expect(screen.getByText('A policy can send at most 50 notifications.')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('escalation-step-0-times'), { target: { value: 5 } });
    expect(screen.queryByText('A policy can send at most 50 notifications.')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
  });
});

it('keeps the footer outside the scrollable escalation body (G5)', async () => {
  mount();
  const body = screen.getByTestId('escalation-policy-drawer-body');
  const footer = screen.getByTestId('escalation-policy-drawer-footer');
  expect(body).toHaveClass('flex-1', 'overflow-y-auto');
  expect(body).not.toContainElement(footer);
  expect(body.parentElement).toBe(footer.parentElement);
  expect(footer).toContainElement(screen.getByTestId('escalation-policy-drawer-save'));
  await waitFor(() => expect(screen.getByTestId('escalation-policy-drawer-save')).toBeEnabled());
});
