import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import InheritedField from './InheritedField';

describe('InheritedField', () => {
  it('shows the inherited VALUE as the placeholder when blank, not just the source label', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={() => {}}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    const input = screen.getByTestId('tax-field') as HTMLInputElement;
    expect(input.placeholder).toBe('7.25');
    expect(screen.getByText(/inherits from partner default/i)).toBeInTheDocument();
  });

  it('shows a "no inherited value configured" note when inheritedValue is null', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={() => {}}
        inheritedValue={null} inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    expect(screen.getByText(/no partner default configured/i)).toBeInTheDocument();
  });

  it('calls onChange with the typed value', async () => {
    const onChange = vi.fn();
    render(
      <InheritedField
        id="tax" label="Tax rate" value="" onChange={onChange}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    await userEvent.type(screen.getByTestId('tax-field'), '5');
    expect(onChange).toHaveBeenCalledWith('5');
  });

  it('an explicit override value hides the inherited-value helper text but shows the "overrides" note with the inherited value', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="9.5" onChange={() => {}}
        inheritedValue="7.25" inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    const input = screen.getByTestId('tax-field') as HTMLInputElement;
    expect(input.value).toBe('9.5');
    expect(screen.queryByText(/inherits from partner default/i)).not.toBeInTheDocument();
    // Rule 4: even while overriding, the inherited VALUE stays visible, not
    // just the source label — otherwise there's no way to see what clearing
    // the field would revert to.
    expect(screen.getByText(/overrides partner default \(7\.25\)/i)).toBeInTheDocument();
  });

  it('an override with no inherited value falls back to the source-only "overrides" note', () => {
    render(
      <InheritedField
        id="tax" label="Tax rate" value="9.5" onChange={() => {}}
        inheritedValue={null} inheritedSource="Partner default"
        data-testid="tax-field"
      />
    );
    expect(screen.getByText(/^overrides partner default$/i)).toBeInTheDocument();
  });

  it('renders without a visible <label> element when hideLabel is set, but keeps an accessible name via aria-label', () => {
    render(
      <InheritedField
        id="sla-low-response" label="Low priority — response SLA" value="" onChange={() => {}}
        inheritedValue="240" inheritedSource="Partner default"
        data-testid="sla-field" hideLabel
      />
    );
    const input = screen.getByTestId('sla-field') as HTMLInputElement;
    expect(input.placeholder).toBe('240');
    // No <label> element should render at all — the compact table cell
    // relies on the row's own label cell instead.
    expect(document.querySelector('label')).toBeNull();
    // But the input must still carry an accessible name (rule: hideLabel
    // never means "no name" — see the CLAUDE.md a11y note on this prop).
    expect(screen.getByLabelText('Low priority — response SLA')).toBe(input);
  });
});
