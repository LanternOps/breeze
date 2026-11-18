import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FormCard from './FormCard';
import { PartnerSettingsSaveContext } from './partnerSettingsSaveContext';

describe('FormCard', () => {
  it('renders a noValidate form whose submit runs the given save without reloading', () => {
    const onSubmit = vi.fn();
    render(<FormCard onSubmit={onSubmit}><input aria-label="Name" /></FormCard>);
    const form = screen.getByLabelText('Name').closest('form')!;
    expect(form.noValidate).toBe(true);
    const event = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('without an onSubmit prop it submits through the page save context', () => {
    const submit = vi.fn();
    render(
      <PartnerSettingsSaveContext.Provider value={{ submit, reportAutosave: vi.fn() }}>
        <FormCard><input aria-label="City" /></FormCard>
      </PartnerSettingsSaveContext.Provider>,
    );
    fireEvent.submit(screen.getByLabelText('City').closest('form')!);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('outside the page it renders and submitting is a no-op', () => {
    render(<FormCard><input aria-label="Field" /></FormCard>);
    expect(() => fireEvent.submit(screen.getByLabelText('Field').closest('form')!)).not.toThrow();
  });
});
