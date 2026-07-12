import { formatCurrency } from './i18n/format';

export function formatMinutes(minutes: number | null | undefined): string {
  const m = Math.max(0, minutes ?? 0);
  const h = Math.floor(m / 60);
  const rest = m % 60;
  if (h === 0) return `${rest}m`;
  return rest === 0 ? `${h}h` : `${h}h ${rest}m`;
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** API money fields arrive as numeric strings (numeric(12,2) → '123.40'). */
export function formatMoney(value: string | number | null | undefined): string {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value ?? '');
  return formatCurrency(Number.isFinite(parsed) ? parsed : 0);
}
