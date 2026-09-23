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
});
