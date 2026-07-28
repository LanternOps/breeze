import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';

import UpdateRingForm, { type UpdateRingFormValues } from './UpdateRingForm';

// #1317: the Update Ring now owns the patch auto-approval gate. These tests
// cover the ring-level auto-approve UI (enabled toggle + severities + deferral)
// added to the ring edit form.
describe('UpdateRingForm — ring auto-approve (#1317)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('hides severity/deferral controls until auto-approve is enabled', () => {
    render(<UpdateRingForm onSubmit={vi.fn()} />);

    expect(screen.getByTestId('ring-auto-approve-section')).toBeInTheDocument();
    expect(screen.queryByTestId('ring-auto-approve-deferral')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));

    expect(screen.getByTestId('ring-auto-approve-deferral')).toBeInTheDocument();
    expect(screen.getByTestId('ring-auto-approve-severity-critical')).toBeInTheDocument();
  });

  it('submits the typed auto-approve gate with selected severities and deferral', async () => {
    const onSubmit = vi.fn();
    render(<UpdateRingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), {
      target: { value: 'Pilot' },
    });
    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));
    fireEvent.click(screen.getByTestId('ring-auto-approve-severity-critical'));
    fireEvent.click(screen.getByTestId('ring-auto-approve-severity-important'));
    fireEvent.change(screen.getByTestId('ring-auto-approve-deferral'), {
      target: { value: '7' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as UpdateRingFormValues;
    expect(values.autoApprove).toEqual({
      enabled: true,
      severities: ['critical', 'important'],
      deferralDays: 7,
    });
  });

  it('blocks submit when auto-approve is enabled with no severities (fail-closed)', async () => {
    const onSubmit = vi.fn();
    render(<UpdateRingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), {
      target: { value: 'Pilot' },
    });
    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));
    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await screen.findByText('Select at least one severity for auto-approval.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('hydrates the auto-approve gate from edit defaults', () => {
    render(
      <UpdateRingForm
        onSubmit={vi.fn()}
        defaultValues={{
          name: 'Broad',
          autoApprove: { enabled: true, severities: ['critical'], deferralDays: 3 },
        }}
      />
    );

    expect(screen.getByTestId('ring-auto-approve-enabled')).toBeChecked();
    expect(screen.getByTestId('ring-auto-approve-deferral')).toHaveValue(3);
  });

  // The top-level "Deferral" field was removed from the UI; the ring's fallback
  // `deferralDays` is now derived from the default rule on submit.
  it('syncs top-level deferralDays to the default rule hold on submit', async () => {
    const onSubmit = vi.fn();
    render(<UpdateRingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));
    fireEvent.click(screen.getByTestId('ring-auto-approve-severity-critical'));
    fireEvent.change(screen.getByTestId('ring-auto-approve-deferral'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as UpdateRingFormValues;
    expect(values.deferralDays).toBe(5);
    expect(values.autoApprove.deferralDays).toBe(5);
  });

  it('zeroes the fallback hold when the default rule is manual', async () => {
    const onSubmit = vi.fn();
    render(
      <UpdateRingForm
        onSubmit={onSubmit}
        defaultValues={{ name: 'Manual', deferralDays: 9, autoApprove: { enabled: false, severities: [], deferralDays: 9 } }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as UpdateRingFormValues;
    expect(values.deferralDays).toBe(0);
    expect(values.autoApprove.deferralDays).toBe(0);
  });

  it('adds an override pre-filled from the default rule and submits it in categoryRules', async () => {
    const onSubmit = vi.fn();
    render(<UpdateRingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));
    fireEvent.click(screen.getByTestId('ring-auto-approve-severity-critical'));
    fireEvent.click(screen.getByTestId('ring-auto-approve-severity-important'));
    fireEvent.change(screen.getByTestId('ring-auto-approve-deferral'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /add override/i }));
    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as UpdateRingFormValues;
    expect(values.categoryRules).toHaveLength(1);
    expect(values.categoryRules?.[0]).toMatchObject({
      category: 'security',
      autoApprove: true,
      autoApproveSeverities: ['critical', 'important'],
      deferralDaysOverride: 7,
    });
  });

  // #2609: every form control must have an associated <label> so screen readers
  // announce a name and getByLabel(...) queries (testing-library / Playwright)
  // resolve it.
  it('associates labels with their inputs (a11y, #2609)', () => {
    render(<UpdateRingForm onSubmit={vi.fn()} />);

    // Text/number inputs in the identity + enforcement zones.
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Rollout order')).toBeInTheDocument();
    expect(screen.getByLabelText('Description')).toBeInTheDocument();
    expect(screen.getByLabelText('Deadline (days)')).toBeInTheDocument();
    expect(screen.getByLabelText('Reboot grace (hours)')).toBeInTheDocument();

    // The default-rule "Hold after release" input only exists once auto-approve
    // is enabled; enabling it also reveals the severities group label.
    fireEvent.click(screen.getByTestId('ring-auto-approve-enabled'));
    expect(screen.getByLabelText('Hold after release')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Auto-approve severities' })
    ).toBeInTheDocument();
  });

  it('submits deadlineDays as null when left blank', async () => {
    const onSubmit = vi.fn();
    render(<UpdateRingForm onSubmit={onSubmit} />);

    fireEvent.change(screen.getByPlaceholderText('e.g. Pilot, Broad'), { target: { value: 'Pilot' } });
    fireEvent.click(screen.getByRole('button', { name: /save ring/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect((onSubmit.mock.calls[0][0] as UpdateRingFormValues).deadlineDays).toBeNull();
  });
});
