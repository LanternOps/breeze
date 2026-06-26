import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CannedResponsePicker from './CannedResponsePicker';
import type { CannedResponse } from '../../lib/ticketResponseTemplatesApi';

function tpl(over: Partial<CannedResponse> = {}): CannedResponse {
  return { id: '1', name: 'Greeting', body: 'Hi {{requester_name}}', category: null, sortOrder: 0, isActive: true, ...over };
}

describe('CannedResponsePicker', () => {
  it('renders nothing when there are no templates', () => {
    const { container } = render(<CannedResponsePicker templates={[]} vars={{}} onInsert={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it('inserts the selected template with variables substituted', () => {
    const onInsert = vi.fn();
    render(<CannedResponsePicker templates={[tpl()]} vars={{ requester_name: 'Ada' }} onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(onInsert).toHaveBeenCalledWith('Hi Ada');
  });

  it('renders unknown variables as empty (no raw token leak)', () => {
    const onInsert = vi.fn();
    render(<CannedResponsePicker templates={[tpl({ body: 'Hi {{requester_name}} {{missing}}' })]} vars={{}} onInsert={onInsert} />);
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(onInsert).toHaveBeenCalledWith('Hi  ');
  });

  it('closes the menu after selecting', () => {
    render(<CannedResponsePicker templates={[tpl()]} vars={{}} onInsert={() => {}} />);
    fireEvent.click(screen.getByTestId('canned-picker-button'));
    expect(screen.getByTestId('canned-picker-menu')).toBeTruthy();
    fireEvent.click(screen.getByTestId('canned-picker-option-1'));
    expect(screen.queryByTestId('canned-picker-menu')).toBeNull();
  });
});
