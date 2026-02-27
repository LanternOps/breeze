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

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || seconds < 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
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

const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

export function sanitizeHexColor(value: string, fallback: string): string {
  if (!HEX_COLOR_REGEX.test(fallback)) {
    return '#000000';
  }

  if (!HEX_COLOR_REGEX.test(value)) {
    return fallback.toLowerCase();
  }

  const normalized = value.length === 4
    ? `#${value
        .slice(1)
        .split('')
        .map((char) => char + char)
        .join('')}`
    : value;

  return normalized.toLowerCase();
}

export type UiColorToken = {
  hex: string;
  bgClass: string;
  borderClass: string;
  textOnClass: string;
};

const UI_COLOR_TOKENS: UiColorToken[] = [
  { hex: '#1d4ed8', bgClass: 'bg-blue-700', borderClass: 'border-blue-700', textOnClass: 'text-white' },
  { hex: '#2563eb', bgClass: 'bg-blue-600', borderClass: 'border-blue-600', textOnClass: 'text-white' },
  { hex: '#0ea5e9', bgClass: 'bg-sky-500', borderClass: 'border-sky-500', textOnClass: 'text-white' },
  { hex: '#14b8a6', bgClass: 'bg-teal-500', borderClass: 'border-teal-500', textOnClass: 'text-slate-950' },
  { hex: '#22c55e', bgClass: 'bg-green-500', borderClass: 'border-green-500', textOnClass: 'text-slate-950' },
  { hex: '#f97316', bgClass: 'bg-orange-500', borderClass: 'border-orange-500', textOnClass: 'text-slate-950' },
  { hex: '#f59e0b', bgClass: 'bg-amber-500', borderClass: 'border-amber-500', textOnClass: 'text-slate-950' },
  { hex: '#e11d48', bgClass: 'bg-rose-600', borderClass: 'border-rose-600', textOnClass: 'text-white' },
  { hex: '#7c3aed', bgClass: 'bg-violet-600', borderClass: 'border-violet-600', textOnClass: 'text-white' },
  { hex: '#64748b', bgClass: 'bg-slate-500', borderClass: 'border-slate-500', textOnClass: 'text-white' },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const value = sanitizeHexColor(hex, '#64748b');
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function resolveUiColorToken(value: string, fallback = '#64748b'): UiColorToken {
  const target = hexToRgb(sanitizeHexColor(value, fallback));
  let bestToken = UI_COLOR_TOKENS[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const token of UI_COLOR_TOKENS) {
    const candidate = hexToRgb(token.hex);
    const distance =
      (target.r - candidate.r) ** 2 +
      (target.g - candidate.g) ** 2 +
      (target.b - candidate.b) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestToken = token;
    }
  }

  return bestToken;
}

export function widthPercentClass(percent: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(percent)), 0, 100);
  return `u-w-pct-${clamped}`;
}

export function heightPercentClass(percent: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(percent)), 0, 100);
  return `u-h-pct-${clamped}`;
}

export function paddingLeftPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 512);
  return `u-pl-px-${clamped}`;
}

export function marginLeftPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 512);
  return `u-ml-px-${clamped}`;
}

export function leftPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 2048);
  return `u-left-px-${clamped}`;
}

export function topPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 2048);
  return `u-top-px-${clamped}`;
}

export function heightPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 1200);
  return `u-h-px-${clamped}`;
}

export function minHeightPxClass(pixels: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(pixels)), 0, 1200);
  return `u-min-h-px-${clamped}`;
}

export function gridColsClass(columns: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(columns)), 1, 24);
  return `u-grid-cols-${clamped}`;
}

export function gridAutoRowsPxClass(rowHeight: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(rowHeight)), 1, 400);
  return `u-grid-auto-rows-px-${clamped}`;
}

export function gapPxClass(gap: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(gap)), 0, 64);
  return `u-gap-px-${clamped}`;
}

export function gridColStartClass(start: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(start)), 1, 24);
  return `u-col-start-${clamped}`;
}

export function gridColSpanClass(span: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(span)), 1, 24);
  return `u-col-span-${clamped}`;
}

export function gridRowStartClass(start: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(start)), 1, 200);
  return `u-row-start-${clamped}`;
}

export function gridRowSpanClass(span: number): string {
  const clamped = clamp(Math.round(toFiniteNumber(span)), 1, 24);
  return `u-row-span-${clamped}`;
}
