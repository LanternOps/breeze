import '@/lib/i18n';
import { render, screen, fireEvent } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, it, expect } from 'vitest';
import ActionsEditor from './ActionsEditor';

function Host({ allowAiTriage = false }: { allowAiTriage?: boolean }) {
  const form = useForm({ defaultValues: { actions: [{ type: 'run_script' }] } });
  return (
    <FormProvider {...form}>
      <ActionsEditor name="actions" allowAiTriage={allowAiTriage} />
      <output data-testid="count">{form.watch('actions').length}</output>
    </FormProvider>
  );
}

describe('ActionsEditor (#5289)', () => {
  it('adds and removes actions through the form context', () => {
    render(<Host />);
    fireEvent.click(screen.getByRole('button', { name: /add action/i }));
    expect(screen.getByTestId('count').textContent).toBe('2');
    fireEvent.click(screen.getAllByRole('button', { name: /remove action/i })[0]);
    expect(screen.getByTestId('count').textContent).toBe('1');
  });

  it('offers ai_triage only when allowed', () => {
    const { unmount } = render(<Host />);
    expect(screen.queryByRole('option', { name: /ai triage/i })).toBeNull();
    unmount();
    render(<Host allowAiTriage />);
    expect(screen.getByRole('option', { name: /ai triage/i })).toBeInTheDocument();
  });

  it('hides the "when offline" control in compact mode', () => {
    function CompactHost() {
      const form = useForm({ defaultValues: { responses: [{ type: 'run_script' }] } });
      return (
        <FormProvider {...form}>
          <ActionsEditor name="responses" compact />
        </FormProvider>
      );
    }
    render(<CompactHost />);
    expect(screen.queryByTestId('action-0-when-offline-select')).toBeNull();
  });

  it('allows removing down to zero rows when minItems is not set', () => {
    function ZeroHost() {
      const form = useForm({ defaultValues: { recurrenceActions: [{ type: 'run_script' }] } });
      return (
        <FormProvider {...form}>
          <ActionsEditor name="recurrenceActions" />
          <output data-testid="count">{form.watch('recurrenceActions').length}</output>
        </FormProvider>
      );
    }
    render(<ZeroHost />);
    fireEvent.click(screen.getByRole('button', { name: /remove action/i }));
    expect(screen.getByTestId('count').textContent).toBe('0');
  });

  it('disables remove at exactly minItems (regression: AutomationForm passes minItems={1} so a Jobs automation can never ship with zero actions)', () => {
    function MinItemsHost() {
      const form = useForm({ defaultValues: { actions: [{ type: 'run_script' }] } });
      return (
        <FormProvider {...form}>
          <ActionsEditor name="actions" minItems={1} />
          <output data-testid="count">{form.watch('actions').length}</output>
        </FormProvider>
      );
    }
    render(<MinItemsHost />);
    // At the floor: the remove button on the only row must be disabled.
    expect(screen.getByRole('button', { name: /remove action/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /remove action/i }));
    expect(screen.getByTestId('count').textContent).toBe('1');

    // Above the floor: remove is enabled and works normally.
    fireEvent.click(screen.getByRole('button', { name: /add action/i }));
    expect(screen.getAllByRole('button', { name: /remove action/i })[0]).not.toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: /remove action/i })[0]);
    expect(screen.getByTestId('count').textContent).toBe('1');
  });
});
