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
  if (ms < 50) return 'text-success';
  if (ms < 150) return 'text-warning';
  return 'text-destructive';
}
