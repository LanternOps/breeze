import { formatNumber } from '@/lib/i18n/format';

// Shared by DiscoveredAssetList (table/card rows) and NetworkDeviceDetailPage
// (stat strip) so the two surfaces can never drift on ping formatting or the
// color thresholds that make a slow response visually obvious at a glance.
export function formatPing(ms?: number | null): string {
  if (ms == null) return '—';
  if (ms < 1) return '<1 ms';
  return `${formatNumber(ms, { minimumFractionDigits: 1, maximumFractionDigits: 1 })} ms`;
}

export function pingColor(ms?: number | null): string {
  if (ms == null) return 'text-muted-foreground';
  if (ms < 5) return 'text-green-600 dark:text-green-400';
  if (ms < 50) return 'text-emerald-600 dark:text-emerald-400';
  if (ms < 200) return 'text-yellow-600 dark:text-yellow-400';
  return 'text-red-600 dark:text-red-400';
}
