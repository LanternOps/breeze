// Devices list sort state in the URL hash (#9037), next to the filter and
// class keys, so a sorted view survives reload and can be shared. Same
// `key=value&key=value` fragment shape as deviceClassFilter / filterUrl; every
// writer preserves the keys it does not own.
import { replaceUrl } from '../../lib/replaceUrl';
import { isValidColumnId, type ColumnId } from './columnVisibility';

const HASH_KEY = 'sort';

export type SortDirection = 'asc' | 'desc';

export interface ListSort {
  field: ColumnId;
  direction: SortDirection;
}

function fragmentParts(hash: string): string[] {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  return raw.split('&').filter(Boolean);
}

/** `#sort=cpu.desc` → { field: 'cpu', direction: 'desc' }; null when absent or invalid. */
export function readSortFromHash(hash: string): ListSort | null {
  for (const part of fragmentParts(hash)) {
    const [key, value] = part.split('=');
    if (key !== HASH_KEY || !value) continue;
    const [field, direction] = decodeURIComponent(value).split('.');
    if (field && isValidColumnId(field) && (direction === 'asc' || direction === 'desc')) {
      return { field, direction };
    }
    return null;
  }
  return null;
}

export function writeSortToHash(sort: ListSort | null): void {
  if (typeof window === 'undefined') return;
  const others = fragmentParts(window.location.hash).filter((p) => !p.startsWith(`${HASH_KEY}=`));
  const next = sort ? [...others, `${HASH_KEY}=${sort.field}.${sort.direction}`] : others;
  const newHash = next.length > 0 ? `#${next.join('&')}` : '';
  if (newHash !== window.location.hash) {
    // Replace, don't push: a header click is not a navigation step.
    replaceUrl(`${window.location.pathname}${window.location.search}${newHash}`);
  }
}
