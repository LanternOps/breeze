// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { InvoiceSummary } from '@/lib/api';
import { BilledByMonth, billedByMonth } from './BilledByMonth';

const inv = (over: Partial<InvoiceSummary> = {}): InvoiceSummary => ({
  id: 'a',
  invoiceNumber: 'INV-1',
  title: null,
  status: 'sent',
  currencyCode: 'USD',
  issueDate: '2026-09-03',
  dueDate: null,
  total: '100.00',
  amountPaid: '0',
  balance: '100.00',
  depositDue: null,
  ...over,
});

describe('billedByMonth', () => {
  it('sums invoice totals into the trailing twelve months, oldest first, current month last', () => {
    const months = billedByMonth(
      [inv({ issueDate: '2026-09-03', total: '100' }), inv({ id: 'b', issueDate: '2026-09-20', total: '50' }), inv({ id: 'c', issueDate: '2025-10-01', total: '7' }), inv({ id: 'd', issueDate: '2025-09-30', total: '999' })],
      new Date('2026-09-15T12:00:00Z'),
    );
    expect(months).toHaveLength(12);
    expect(months[0]).toEqual({ key: '2025-10', label: 'Oct', total: 7 });
    expect(months[11]).toEqual({ key: '2026-09', label: 'Sep', total: 150 });
    // 2025-09 is the thirteenth month back: outside the window.
    expect(months.reduce((s, m) => s + m.total, 0)).toBe(157);
  });

  it('ignores draft and void invoices and rows without an issue date', () => {
    const months = billedByMonth(
      [inv({ status: 'draft' }), inv({ id: 'b', status: 'void' }), inv({ id: 'c', issueDate: null })],
      new Date('2026-09-15T12:00:00Z'),
    );
    expect(months.every((m) => m.total === 0)).toBe(true);
  });
});

describe('BilledByMonth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('draws one bar per month with a hover title, and totals the window in words', () => {
    render(<BilledByMonth invoices={[inv({ total: '1200' }), inv({ id: 'b', issueDate: '2026-03-10', total: '300' })]} />);
    const bars = screen.getAllByTestId(/^portal-billed-bar-/);
    expect(bars).toHaveLength(12);
    expect(screen.getByTestId('portal-billed-bar-2026-09').querySelector('title')?.textContent).toBe('Sep 2026: $1,200.00');
    expect(screen.getByTestId('portal-billed-bar-2026-03').querySelector('title')?.textContent).toBe('Mar 2026: $300.00');
    expect(screen.getByTestId('portal-billed-total')).toHaveTextContent('$1,500.00 billed in the last 12 months');
  });

  it('renders nothing when the window is empty or currencies are mixed', () => {
    const { unmount } = render(<BilledByMonth invoices={[inv({ issueDate: '2024-01-01' })]} />);
    expect(screen.queryByTestId('portal-billed-by-month')).toBeNull();
    unmount();
    render(<BilledByMonth invoices={[inv(), inv({ id: 'b', currencyCode: 'EUR' })]} />);
    expect(screen.queryByTestId('portal-billed-by-month')).toBeNull();
  });
});

describe('BilledByMonth — phone width', () => {
  it('scales the figure to the sheet instead of a fixed pixel width', () => {
    render(<BilledByMonth invoices={[inv({ total: '1200' })]} />);
    const svg = screen.getByRole('img', { name: /Billed by month/ });
    expect(svg.getAttribute('width')).toBeNull();
    expect(svg.getAttribute('class') ?? '').toMatch(/\bw-full\b/);
  });
});
