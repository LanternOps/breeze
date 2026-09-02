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

  it('rejects more than five values with an inline error and does not emit', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '10, 20, 30, 40, 50, 60' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('dedupes duplicate values within the same input', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '50, 50, 80' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenLastCalledWith([50, 80]);
  });

  it('commits on Enter without requiring blur', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '50, 80' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith([50, 80]);
  });

  it('clears a stale inline error as soon as the user edits the text again', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[]} onChange={onChange} testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('thresholds-error')).toBeInTheDocument();
    fireEvent.change(input, { target: { value: '50' } });
    expect(screen.queryByTestId('thresholds-error')).not.toBeInTheDocument();
  });

  // The commit path swallows unparseable text (no onChange), so the page above
  // has no other way to know its Save button would persist the stale value.
  it('reports invalid on an unparseable entry and valid again once it parses', () => {
    const onValidityChange = vi.fn();
    render(
      <AiBudgetThresholdsInput value={[]} onChange={vi.fn()} onValidityChange={onValidityChange} testId="thresholds" />,
    );
    const input = screen.getByTestId('thresholds-input');

    fireEvent.change(input, { target: { value: '100' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'thresholds-error');
    expect(screen.getByTestId('thresholds-error')).toHaveAttribute('id', 'thresholds-error');

    fireEvent.change(input, { target: { value: '50, 80' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('releases the caller when it unmounts holding unparseable text', () => {
    const onValidityChange = vi.fn();
    const { unmount } = render(
      <AiBudgetThresholdsInput value={[]} onChange={vi.fn()} onValidityChange={onValidityChange} testId="thresholds" />,
    );
    const input = screen.getByTestId('thresholds-input');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(onValidityChange).toHaveBeenLastCalledWith(false);

    unmount();
    expect(onValidityChange).toHaveBeenLastCalledWith(true);
  });

  it('does not commit a disabled input', () => {
    const onChange = vi.fn();
    render(<AiBudgetThresholdsInput value={[50]} onChange={onChange} disabled testId="thresholds" />);
    const input = screen.getByTestId('thresholds-input') as HTMLInputElement;
    expect(input.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '80' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});
