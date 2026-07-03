import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { DetectionRule } from '@breeze/shared';
import DetectionRulesEditor from './DetectionRulesEditor';

describe('DetectionRulesEditor', () => {
  it('shows the empty-state hint when there are no rules', () => {
    render(<DetectionRulesEditor rules={[]} onChange={() => {}} />);
    expect(screen.getByText(/No detection rules/i)).toBeTruthy();
  });

  it('adds a registry rule (default type) when Add rule is clicked', () => {
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={[]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('detection-rule-add'));
    expect(onChange).toHaveBeenCalledWith([{ type: 'registry', hive: 'HKLM', path: '' }]);
  });

  it('renders type-specific fields and edits a clause', () => {
    const rules: DetectionRule[] = [{ type: 'file_exists', path: '' }];
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={rules} onChange={onChange} />);

    const pathInput = screen.getByLabelText('File or folder path') as HTMLInputElement;
    fireEvent.change(pathInput, { target: { value: 'C:\\Program Files\\Acme\\app.exe' } });
    expect(onChange).toHaveBeenCalledWith([
      { type: 'file_exists', path: 'C:\\Program Files\\Acme\\app.exe' },
    ]);
  });

  it('switches clause type and resets to a blank clause of the new type', () => {
    const rules: DetectionRule[] = [{ type: 'file_exists', path: 'C:\\x' }];
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={rules} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('detection-rule-type'), { target: { value: 'msi_product_code' } });
    expect(onChange).toHaveBeenCalledWith([{ type: 'msi_product_code', productCode: '' }]);
  });

  it('switches to a file_version clause with default operator and edits its fields', () => {
    const rules: DetectionRule[] = [{ type: 'file_exists', path: 'C:\\x' }];
    const onChange = vi.fn();
    const { rerender } = render(<DetectionRulesEditor rules={rules} onChange={onChange} />);

    fireEvent.change(screen.getByTestId('detection-rule-type'), { target: { value: 'file_version' } });
    expect(onChange).toHaveBeenCalledWith([{ type: 'file_version', path: '', operator: '>=', version: '' }]);

    const fvRules: DetectionRule[] = [{ type: 'file_version', path: '', operator: '>=', version: '' }];
    rerender(<DetectionRulesEditor rules={fvRules} onChange={onChange} />);

    fireEvent.change(screen.getByLabelText('File path'), {
      target: { value: 'C:\\Program Files\\Acme\\app.exe' },
    });
    expect(onChange).toHaveBeenCalledWith([
      { type: 'file_version', path: 'C:\\Program Files\\Acme\\app.exe', operator: '>=', version: '' },
    ]);

    fireEvent.change(screen.getByLabelText('Target file version'), { target: { value: '1.2.3.4' } });
    expect(onChange).toHaveBeenCalledWith([
      { type: 'file_version', path: '', operator: '>=', version: '1.2.3.4' },
    ]);

    fireEvent.change(screen.getByLabelText('Version comparison operator'), { target: { value: '==' } });
    expect(onChange).toHaveBeenCalledWith([
      { type: 'file_version', path: '', operator: '==', version: '' },
    ]);
  });

  it('removes a clause', () => {
    const rules: DetectionRule[] = [
      { type: 'file_exists', path: 'C:\\a' },
      { type: 'file_exists', path: 'C:\\b' },
    ];
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={rules} onChange={onChange} />);

    fireEvent.click(screen.getAllByTestId('detection-rule-remove')[0]!);
    expect(onChange).toHaveBeenCalledWith([{ type: 'file_exists', path: 'C:\\b' }]);
  });
});
