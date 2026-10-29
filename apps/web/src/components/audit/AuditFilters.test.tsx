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

  // #9941: the panel unmounts on Apply, so reopening must reflect what is applied.
  it('reopens showing the applied custom range and selections, not the defaults', () => {
    render(
      <AuditFilters
        initialFilters={{
          datePreset: 'custom',
          startDate: '2026-10-01',
          endDate: '2026-10-05',
          actions: ['script'],
          resources: ['device'],
          search: 'disk',
        }}
      />
    );
    const dates = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(dates.map((d) => d.value)).toEqual(['2026-10-01', '2026-10-05']);
    expect(screen.getByTestId('audit-date-preset-custom').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('audit-date-preset-7d').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByTestId('audit-action-option-script').querySelector('input')!.checked).toBe(true);
    expect(screen.getByTestId('audit-resource-option-device').querySelector('input')!.checked).toBe(true);
    expect(screen.getByTestId<HTMLInputElement>('audit-details-search').value).toBe('disk');
  });

  it('re-applying a reopened panel unchanged keeps the same filters', () => {
    const onApply = vi.fn();
    const applied = {
      datePreset: 'custom' as const,
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      userId: undefined,
      userEmail: undefined,
      actions: ['script'],
      resources: [],
      search: '',
    };
    render(<AuditFilters initialFilters={applied} onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /apply filters/i }));
    expect(onApply).toHaveBeenCalledWith(applied);
  });

  it('opens with the defaults when no filters are applied', () => {
    render(<AuditFilters initialFilters={null} />);
    expect(screen.getByTestId('audit-date-preset-7d').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('input[type="date"]').length).toBe(0);
  });
});
