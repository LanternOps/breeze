import '@/lib/i18n';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import { describe, it, expect } from 'vitest';
import MonitorConditionFields from './MonitorConditionFields';
import { defaultConditionFor } from './monitorKindFields';

function Host() {
  const form = useForm({
    defaultValues: { condition: defaultConditionFor('event_log') },
  });
  return (
    <FormProvider {...form}>
      <MonitorConditionFields kind="event_log" name="condition" />
    </FormProvider>
  );
}

// #8174 — the agent ships Information/Warning Application events only from an
// allowlisted provider set; the editor warns before save for anything else.
describe('MonitorConditionFields event_log collection warning (#8174)', () => {
  it('offers the info level', () => {
    render(<Host />);
    const level = screen.getByTestId('condition-field-level') as HTMLSelectElement;
    expect([...level.options].map((o) => o.value)).toContain('info');
  });

  it('shows no warning for the default application/error rule', () => {
    render(<Host />);
    expect(screen.queryByTestId('event-log-collection-warning')).toBeNull();
  });

  it('warns for an info-level Application source outside the allowlist', () => {
    render(<Host />);
    fireEvent.change(screen.getByTestId('condition-field-level'), { target: { value: 'info' } });
    fireEvent.change(screen.getByTestId('condition-field-sourcePattern'), { target: { value: 'Application Error' } });
    const warning = screen.getByTestId('event-log-collection-warning');
    expect(warning.textContent).toContain('Application Error');
    expect(warning.textContent).toContain('MsiInstaller');
  });

  it('warns when an info-level Application rule names no source', () => {
    render(<Host />);
    fireEvent.change(screen.getByTestId('condition-field-level'), { target: { value: 'info' } });
    expect(screen.getByTestId('event-log-collection-warning').textContent).toContain('MsiInstaller');
  });

  it('clears the warning for an allowlisted provider', () => {
    render(<Host />);
    fireEvent.change(screen.getByTestId('condition-field-level'), { target: { value: 'info' } });
    fireEvent.change(screen.getByTestId('condition-field-sourcePattern'), { target: { value: 'MsiInstaller' } });
    expect(screen.queryByTestId('event-log-collection-warning')).toBeNull();
  });
});
