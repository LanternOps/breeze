import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { BUSINESS_REPORT_REQUIRED_PERMISSIONS as SHARED_REQUIRED_PERMISSIONS } from '@breeze/shared';

let granted = new Set<string>();
vi.mock('@/lib/permissions', () => ({
  usePermissions: () => ({ can: (resource: string, action: string) => granted.has(`${resource}:${action}`) }),
}));

import { BUSINESS_REPORT_REQUIRED_PERMISSIONS, useCanUseBusinessReportType } from './businessReportAccess';

describe('business report card gate (#3198)', () => {
  it('is the shared constant the API registry requires — not a hand-synced copy', () => {
    expect(BUSINESS_REPORT_REQUIRED_PERMISSIONS).toBe(SHARED_REQUIRED_PERMISSIONS);
  });

  it('allows a business type only when every shared required grant is held', () => {
    granted = new Set(['tickets:read']);
    const { result } = renderHook(() => useCanUseBusinessReportType());
    expect(result.current('ticket_sla_attainment')).toBe(true);
    expect(result.current('technician_time_billability')).toBe(false);
    expect(result.current('ar_aging')).toBe(false);
    expect(result.current('device_inventory')).toBe(true);

    granted = new Set(['tickets:read', 'time_entries:read', 'invoices:read']);
    const { result: all } = renderHook(() => useCanUseBusinessReportType());
    expect(all.current('technician_time_billability')).toBe(true);
    expect(all.current('ar_aging')).toBe(true);
  });

  it('gates ai_usage_by_client on BOTH invoices:read and ai_sessions:read_all (#7608)', () => {
    granted = new Set(['invoices:read']);
    const { result: invoicesOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(invoicesOnly.current('ai_usage_by_client')).toBe(false);

    granted = new Set(['ai_sessions:read_all']);
    const { result: sessionsOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(sessionsOnly.current('ai_usage_by_client')).toBe(false);

    granted = new Set(['invoices:read', 'ai_sessions:read_all']);
    const { result: both } = renderHook(() => useCanUseBusinessReportType());
    expect(both.current('ai_usage_by_client')).toBe(true);
  });

  it('gates mrr_renewals on contracts:read alone', () => {
    granted = new Set(['tickets:read', 'time_entries:read', 'invoices:read', 'ai_sessions:read_all']);
    const { result: without } = renderHook(() => useCanUseBusinessReportType());
    expect(without.current('mrr_renewals')).toBe(false);

    granted = new Set(['contracts:read']);
    const { result: held } = renderHook(() => useCanUseBusinessReportType());
    expect(held.current('mrr_renewals')).toBe(true);
  });

  it('gates quote_win_rate on quotes:read alone', () => {
    granted = new Set(['tickets:read', 'time_entries:read', 'invoices:read', 'ai_sessions:read_all', 'contracts:read']);
    const { result: without } = renderHook(() => useCanUseBusinessReportType());
    expect(without.current('quote_win_rate')).toBe(false);

    granted = new Set(['quotes:read']);
    const { result: held } = renderHook(() => useCanUseBusinessReportType());
    expect(held.current('quote_win_rate')).toBe(true);
  });

  it('gates client_profitability on BOTH invoices:read and time_entries:read', () => {
    granted = new Set(['invoices:read']);
    const { result: invoicesOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(invoicesOnly.current('client_profitability')).toBe(false);

    granted = new Set(['time_entries:read']);
    const { result: timeOnly } = renderHook(() => useCanUseBusinessReportType());
    expect(timeOnly.current('client_profitability')).toBe(false);

    granted = new Set(['invoices:read', 'time_entries:read']);
    const { result: both } = renderHook(() => useCanUseBusinessReportType());
    expect(both.current('client_profitability')).toBe(true);
  });
});
