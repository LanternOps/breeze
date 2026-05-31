// URL hash encoding/decoding for the v2 chip filter UI.
// Spec section 3.3: `#filtersV2=<base64url(JSON.stringify(FilterConditionGroup))>`.
import type { FilterConditionGroup } from '@breeze/shared';

const HASH_KEY = 'filtersV2';

function toBase64Url(s: string): string {
  if (typeof window === 'undefined') return '';
  // btoa requires latin1; JSON we encode is ASCII for typical filter shapes,
  // but wrap in encodeURIComponent to be safe with non-ASCII tag values etc.
  const bin = unescape(encodeURIComponent(s));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  if (typeof window === 'undefined') return '';
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  return decodeURIComponent(escape(bin));
}

export function encodeFilterToHash(group: FilterConditionGroup | null): string {
  if (!group || group.conditions.length === 0) return '';
  return `${HASH_KEY}=${toBase64Url(JSON.stringify(group))}`;
}

export function decodeFilterFromHash(hash: string): FilterConditionGroup | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === HASH_KEY && v) {
      try {
        return JSON.parse(fromBase64Url(v)) as FilterConditionGroup;
      } catch {
        return null;
      }
    }
  }
  return null;
}

export function writeFilterToHash(group: FilterConditionGroup | null): void {
  if (typeof window === 'undefined') return;
  const encoded = encodeFilterToHash(group);
  // Preserve any non-filtersV2 hash fragments untouched (e.g. #add-device).
  const existing = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const others = existing
    .split('&')
    .filter(p => p && !p.startsWith(`${HASH_KEY}=`));
  const next = encoded ? [encoded, ...others].join('&') : others.join('&');
  const newHash = next ? `#${next}` : '';
  if (newHash !== window.location.hash) {
    // Replace, don't push, so back-button doesn't fill with filter edits.
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}${newHash}`);
  }
}

const FLAG_QUERY = 'filtersV2';
const FLAG_STORAGE_KEY = 'breeze.filtersV2';

/**
 * Whether the v2 chip filter UI is active. Default ON; opt OUT via
 * `?filtersV2=0` (one-off) or `localStorage['breeze.filtersV2'] = 'off'`
 * (sticky). `?filtersV2=1` / `'on'` force it back on. This is the
 * one-release-window flag (#968): default-on, opt-out, removed once the
 * chip bar is proven, along with the legacy DeviceFilterBar.
 */
export function isFiltersV2Enabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const q = new URLSearchParams(window.location.search).get(FLAG_QUERY);
    if (q === '0' || q === 'off' || q === 'false') return false;
    if (q === '1' || q === 'on' || q === 'true') return true;
    const stored = window.localStorage.getItem(FLAG_STORAGE_KEY);
    if (stored === 'off' || stored === 'false') return false;
    if (stored === 'on' || stored === 'true') return true;
  } catch {
    // SSR / Safari private mode — fall through to the default.
  }
  return true;
}
