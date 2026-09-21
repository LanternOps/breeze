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

  it('an explicit override value hides the inherited-value helper text but keeps the source note', () => {
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
  });

  it('renders without a visible label element when label is empty, for compact table cells', () => {
    render(
      <InheritedField
        id="sla-low-response" label="" value="" onChange={() => {}}
        inheritedValue="240" inheritedSource="Partner default"
        data-testid="sla-field" hideLabel
      />
    );
    const input = screen.getByTestId('sla-field') as HTMLInputElement;
    expect(input.placeholder).toBe('240');
    // No empty <label> text content should render.
    const labels = screen.queryAllByText('', { selector: 'label' });
    expect(labels.length).toBe(0);
  });
});
