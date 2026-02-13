import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

export function formatSafeDate(value: string | null | undefined, fallback = '-'): string {
  if (!value) return fallback;
  const d = new Date(value);
  if (isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString();
}

export function friendlyFetchError(err: unknown): string {
  if (!(err instanceof Error)) return 'An unexpected error occurred. Please try again.';
  const msg = err.message;
  if (msg === 'Failed to fetch' || msg.includes('NetworkError')) return 'Network error — check your connection and try again.';
  if (msg.startsWith('401')) return 'Session expired — please log in again.';
  if (msg.startsWith('403')) return 'You do not have permission to view this data.';
  if (msg.startsWith('429')) return 'Too many requests — please wait a moment and retry.';
  if (msg.startsWith('5') && msg.length <= 20) return 'Server error — please try again later.';
  if (msg.includes('Unexpected token') || msg.includes('JSON')) return 'Received an invalid response from the server.';
  return msg;
}

export function formatToolName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;

  return date.toLocaleDateString();
}
