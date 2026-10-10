import type { EdrDetectionStatus, EdrOsPlatform, EdrSeverity } from '@breeze/shared';
import { EDR_OPEN_DETECTION_STATUSES } from '@breeze/shared';

function lookup<T extends string>(table: Readonly<Record<string, T>>, raw: string | number | null | undefined): T | undefined {
  if (raw === null || raw === undefined) return undefined;
  const key = String(raw);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function bucketSeverity(table: Readonly<Record<string, EdrSeverity>>, raw: string | number | null | undefined): EdrSeverity {
  return lookup(table, raw) ?? 'unknown';
}

export function bucketStatus(table: Readonly<Record<string, EdrDetectionStatus>>, raw: string | number | null | undefined): EdrDetectionStatus {
  return lookup(table, raw) ?? 'unknown';
}

export function normalizeMac(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const hex = raw.trim().replace(/[:\-.]/g, '').toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex.match(/.{2}/g)!.join(':');
}

export function normalizeMacs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const mac = normalizeMac(item);
    if (mac) out.add(mac);
  }
  return [...out].sort();
}

export function osPlatformFromName(name: string | null | undefined): EdrOsPlatform {
  const n = (name ?? '').toLowerCase();
  if (!n) return 'other';
  if (n.includes('windows')) return 'windows';
  if (/mac\s?os|os\s?x|darwin/.test(n)) return 'macos';
  if (/linux|ubuntu|debian|centos|red\s?hat|rhel|fedora|suse|alma|rocky|oracle/.test(n)) return 'linux';
  return 'other';
}

export function parseVendorDate(raw: unknown): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  let d: Date;
  if (raw instanceof Date) d = raw;
  else if (typeof raw === 'number') d = new Date(raw < 1e11 ? raw * 1000 : raw);
  else if (typeof raw === 'string') {
    const s = raw.trim();
    if (/^\d+$/.test(s)) d = new Date(Number(s) < 1e11 ? Number(s) * 1000 : Number(s));
    // An ISO date-time with no offset (GravityZone's lastSeen, live 2026-10-08) is read as UTC.
    // `new Date()` would read it as host-local time, so the stored instant moved with the TZ.
    else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) d = new Date(`${s.replace(' ', 'T')}Z`);
    else d = new Date(s);
  } else return null;
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isOpenDetectionStatus(s: EdrDetectionStatus): boolean {
  return (EDR_OPEN_DETECTION_STATUSES as readonly string[]).includes(s);
}
