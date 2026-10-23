import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@/lib/i18n';
import AuditFilters from './AuditFilters';

vi.mock('../../stores/auth', () => ({
  fetchWithAuth: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }),
}));

describe('AuditFilters (#9672)', () => {
  it('offers real code prefixes (script, device, agent.command) as action options', () => {
    render(<AuditFilters />);
    expect(screen.getByTestId('audit-action-option-script')).toBeTruthy();
    expect(screen.getByTestId('audit-action-option-device')).toBeTruthy();
    expect(screen.getByTestId('audit-action-option-agent.command')).toBeTruthy();
    expect(screen.queryByTestId('audit-action-option-dataset')).toBeNull();
  });

  it('applies the selected prefix as the action filter', () => {
    const onApply = vi.fn();
    render(<AuditFilters onApply={onApply} />);
    fireEvent.click(screen.getByTestId('audit-action-option-script').querySelector('input')!);
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(onApply).toHaveBeenCalledWith(expect.objectContaining({ actions: ['script'] }));
  });

  it('Clear All empties the custom dates instead of restoring stale ones', () => {
    render(<AuditFilters />);
    fireEvent.click(screen.getByRole('button', { name: /^custom$/i }));
    const dates = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    fireEvent.change(dates()[0], { target: { value: '2026-10-01' } });
    fireEvent.change(dates()[1], { target: { value: '2026-10-05' } });
    fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
    fireEvent.click(screen.getByRole('button', { name: /^custom$/i }));
    expect(dates().map((d) => d.value)).toEqual(['', '']);
  });
});
