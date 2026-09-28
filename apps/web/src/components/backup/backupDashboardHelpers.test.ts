import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { localizeIsoTimestamps } from './backupDashboardHelpers';

describe('localizeIsoTimestamps (#7213)', () => {
  it('replaces a raw ISO timestamp with the user-formatted date-time', () => {
    const iso = '2026-09-27T17:43:46.976Z';
    const out = localizeIsoTimestamps(`Agent not connected · Completed ${iso}`);
    expect(out).not.toContain(iso);
    expect(out).toBe(`Agent not connected · Completed ${formatDateTime(iso)}`);
  });

  it('leaves text without timestamps untouched', () => {
    expect(localizeIsoTimestamps('disk full')).toBe('disk full');
  });
});
