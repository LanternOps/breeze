import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
});
