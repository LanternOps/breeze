// URL hash encoding/decoding for the v2 chip filter UI.
// Spec section 3.3: `#filtersV2=<base64url(JSON.stringify(FilterConditionGroup))>`.
import type { FilterConditionGroup } from '@breeze/shared';

const HASH_KEY = 'filtersV2';

// Pure, isomorphic base64url. The old body returned '' when `window` was
// undefined, so any link built from encodeFilterToHash during SSR was silently
// `/devices#` (#3205 W06). Byte-identical to the old btoa path for every input:
// unescape(encodeURIComponent(s)) IS the UTF-8 byte sequence TextEncoder emits.
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += B64URL_ALPHABET[a >> 2]! + B64URL_ALPHABET[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += B64URL_ALPHABET[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += B64URL_ALPHABET[c & 63]!;
  }
  return out;   // base64url, unpadded — as before
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

// Flag override lives in the hash (per CLAUDE.md: transient UI state uses
// `window.location.hash`, never query params). A distinct key from the value's
// `filtersV2=` so the two never collide; `writeFilterToHash` preserves it like
// any other non-value fragment.
const FLAG_HASH_KEY = 'filtersV2Flag';
const FLAG_STORAGE_KEY = 'breeze.filtersV2';

function readHashFlag(): string | null {
  const raw = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  for (const part of raw.split('&')) {
    const [k, v] = part.split('=');
    if (k === FLAG_HASH_KEY) return v ?? '';
  }
  return null;
}

/**
 * Whether the v2 chip filter UI is active. Default ON; opt OUT via
 * `#filtersV2Flag=off` (one-off) or `localStorage['breeze.filtersV2'] = 'off'`
 * (sticky). `#filtersV2Flag=on` forces it back on. This is the
 * one-release-window flag (#968): default-on, opt-out, removed once the
 * chip bar is proven, along with the legacy DeviceFilterBar.
 */
export function isFiltersV2Enabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const h = readHashFlag();
    if (h === '0' || h === 'off' || h === 'false') return false;
    if (h === '1' || h === 'on' || h === 'true') return true;
    const stored = window.localStorage.getItem(FLAG_STORAGE_KEY);
    if (stored === 'off' || stored === 'false') return false;
    if (stored === 'on' || stored === 'true') return true;
  } catch {
    // SSR / Safari private mode — fall through to the default.
  }
  return true;
}
