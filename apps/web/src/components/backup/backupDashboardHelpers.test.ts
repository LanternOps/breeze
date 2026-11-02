import { describe, expect, it } from 'vitest';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { formatBytes, localizeIsoTimestamps } from './backupDashboardHelpers';

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

describe('formatBytes — the one backup byte formatter (#9931)', () => {
  it('renders a 2.1e9-byte snapshot identically on every surface (binary units, 3 significant digits)', () => {
    expect(formatBytes(2_100_000_000)).toBe('1.96 GB');
  });

  it('pins precision per magnitude: 2 decimals under 10, 1 under 100, 0 at 100+', () => {
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(4_823_117)).toBe('4.60 MB');
    expect(formatBytes(10_485_760)).toBe('10.0 MB');
    expect(formatBytes(384 * 1024 ** 2)).toBe('384 MB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5.00 TB');
  });

  it('shows whole bytes below 1 KB', () => {
    expect(formatBytes(5)).toBe('5 B');
    expect(formatBytes(1023)).toBe('1,023 B');
  });

  it('promotes to the next unit when rounding reaches 1024 instead of printing "1,024 KB"', () => {
    expect(formatBytes(1023.6)).toBe('1.00 KB');
    expect(formatBytes(1024 * 1023.99)).toBe('1.00 MB');
    expect(formatBytes(1024 ** 3 * 1023.7)).toBe('1.00 TB');
  });

  it('caps at TB rather than inventing a unit', () => {
    expect(formatBytes(2 * 1024 ** 5)).toBe('2,048 TB');
  });

  it('renders zero as 0 B', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('is the only byte formatter in the backup components (no per-surface copies drift again)', () => {
    const sources = import.meta.glob(['./*.ts', './*.tsx', '!./*.test.ts', '!./*.test.tsx'], {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    const offenders = Object.entries(sources)
      .filter(([path]) => path !== './backupDashboardHelpers.ts')
      .filter(([, src]) => /function formatBytes\b|const formatBytes\s*=|formatBytes\b[^\n]*from '@\/lib\/utils'/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('uses the caller placeholder for missing or invalid sizes, 0 B by default', () => {
    expect(formatBytes(null)).toBe('0 B');
    expect(formatBytes(undefined, '--')).toBe('--');
    expect(formatBytes(null, '-')).toBe('-');
    expect(formatBytes(Number.NaN, '--')).toBe('--');
    expect(formatBytes(-1, '--')).toBe('--');
  });
});
