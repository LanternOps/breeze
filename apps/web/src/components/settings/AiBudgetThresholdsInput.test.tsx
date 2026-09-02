import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AiBudgetThresholdsInput from './AiBudgetThresholdsInput';

describe('AiBudgetThresholdsInput', () => {
  it('renders current rungs as chips and emits a normalised list on blur', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50, 80]} onChange={onChange} testId="thresholds" />);
    expect(screen.getByText('50%')).toBeInTheDocument();
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '95, 50, 80' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([50, 80, 95]);
  });

  it('rejects values outside 1..99 with an inline error and does not emit', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('emits undefined (inherit) when cleared', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50]} onChange={onChange} testId="thresholds" />);
    fireEvent.change(screen.getByTestId('thresholds-input'), { target: { value: '' } });
    fireEvent.blur(screen.getByTestId('thresholds-input'));
    expect(onChange).toHaveBeenLastCalledWith(undefined);
  });
});
