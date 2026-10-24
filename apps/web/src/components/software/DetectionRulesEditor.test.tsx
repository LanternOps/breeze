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

  it('renders a service_running rule read-only (type + service name) and leaves it untouched on edits', () => {
    const svc: DetectionRule = { type: 'service_running', serviceName: 'Spooler' };
    const rules: DetectionRule[] = [svc, { type: 'file_exists', path: '' }];
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={rules} onChange={onChange} />);

    const readOnly = screen.getByTestId('detection-rule-readonly');
    expect(readOnly.textContent).toContain('Service running');
    expect(readOnly.textContent).toContain('Spooler');
    // No editable controls (and no misleading registry select) inside the read-only row.
    expect(readOnly.querySelector('input, select')).toBeNull();
    expect(screen.queryByLabelText('Registry hive')).toBeNull();

    fireEvent.change(screen.getByLabelText('File or folder path'), { target: { value: 'C:\\app.exe' } });
    expect(onChange).toHaveBeenCalledWith([svc, { type: 'file_exists', path: 'C:\\app.exe' }]);
  });

  it('lets a read-only rule be removed', () => {
    const svc: DetectionRule = { type: 'service_running', serviceName: 'Spooler' };
    const onChange = vi.fn();
    render(<DetectionRulesEditor rules={[svc]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId('detection-rule-remove'));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
