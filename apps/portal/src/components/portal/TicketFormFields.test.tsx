// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { TicketFormField } from '@breeze/shared';
import TicketFormFields from './TicketFormFields';

afterEach(() => cleanup());

// One field of every supported type, exercising the full renderer surface.
const fields: TicketFormField[] = [
  { key: 'summary', label: 'Summary', type: 'text', required: true },
  { key: 'details', label: 'Details', type: 'textarea', required: false },
  { key: 'category', label: 'Category', type: 'select', required: true, options: ['A', 'B'] },
  { key: 'agree', label: 'I agree', type: 'checkbox', required: true },
  { key: 'when', label: 'When', type: 'date', required: false },
  { key: 'count', label: 'Count', type: 'number', required: false }
];

describe('TicketFormFields (portal)', () => {
  it('renders an input for every field type with its testid', () => {
    render(<TicketFormFields fields={fields} values={{}} errors={{}} onChange={() => {}} />);
    for (const f of fields) {
      expect(screen.getByTestId(`ticket-form-field-${f.key}`)).toBeTruthy();
    }
  });

  it('renders the per-field error line when an error is present', () => {
    render(
      <TicketFormFields
        fields={fields}
        values={{}}
        errors={{ summary: 'This field is required' }}
        onChange={() => {}}
      />
    );
    const errLine = screen.getByTestId('ticket-form-field-error-summary');
    expect(errLine.textContent).toBe('This field is required');
    // No error line for fields without an error.
    expect(screen.queryByTestId('ticket-form-field-error-details')).toBeNull();
  });

  it('emits onChange with the field key and value for text and checkbox', () => {
    const onChange = vi.fn();
    render(<TicketFormFields fields={fields} values={{}} errors={{}} onChange={onChange} />);
    fireEvent.change(screen.getByTestId('ticket-form-field-summary'), { target: { value: 'hi' } });
    expect(onChange).toHaveBeenCalledWith('summary', 'hi');
    fireEvent.click(screen.getByTestId('ticket-form-field-agree'));
    expect(onChange).toHaveBeenCalledWith('agree', true);
  });
});
