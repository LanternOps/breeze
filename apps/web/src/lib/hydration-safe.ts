/**
 * Hydration-safe utilities to prevent React SSR/CSR mismatches
 *
 * These utilities help avoid common hydration errors caused by:
 * - Date.now() or new Date() during render
 * - Math.random() for ID generation
 * - Dynamic values that differ between server and client
 */

import { useId, useState, useEffect, useCallback, useRef } from 'react';

/**
 * Generate a stable ID for use in components.
 * Uses React's useId() hook which is hydration-safe.
 *
 * @param prefix - Optional prefix for the ID
 * @returns A stable, unique ID
 */
export function useStableId(prefix?: string): string {
  const id = useId();
  return prefix ? `${prefix}-${id}` : id;
}

/**
 * Counter-based ID generator for creating multiple IDs in a component.
 * Returns a function that generates sequential IDs based on a stable base.
 */
export function useIdGenerator(prefix: string = 'id'): () => string {
  const baseId = useId();
  const counterRef = useRef(0);

  return useCallback(() => {
    counterRef.current += 1;
    return `${prefix}-${baseId}-${counterRef.current}`;
  }, [baseId, prefix]);
}

/**
 * Hook that returns the current date/time only on the client side.
 * Returns null during SSR and hydration, then updates on the client.
 *
 * @param refreshInterval - Optional interval in ms to refresh the date
 * @returns Date object on client, null during SSR
 */
export function useClientDate(refreshInterval?: number): Date | null {
  const [date, setDate] = useState<Date | null>(null);

  useEffect(() => {
    setDate(new Date());

    if (refreshInterval && refreshInterval > 0) {
      const interval = setInterval(() => {
        setDate(new Date());
      }, refreshInterval);
      return () => clearInterval(interval);
    }
  }, [refreshInterval]);

  return date;
}

/**
 * Hook that returns true only on the client side after hydration.
 * Useful for conditionally rendering client-only content.
 */
export function useIsClient(): boolean {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  return isClient;
}

/**
 * Hook that returns a value only on the client side.
 * During SSR, returns the fallback value.
 *
 * @param clientValue - Value to use on the client
 * @param fallback - Value to use during SSR (default: undefined)
 */
export function useClientValue<T>(clientValue: T, fallback?: T): T | undefined {
  const [value, setValue] = useState<T | undefined>(fallback);

  useEffect(() => {
    setValue(clientValue);
  }, [clientValue]);

  return value;
}

/**
 * Format a date string in a hydration-safe way.
 * Returns a placeholder during SSR, then the formatted date on client.
 *
 * @param dateString - ISO date string to format
 * @param options - Intl.DateTimeFormat options
 * @param placeholder - Placeholder text during SSR (default: '--')
 */
export function useFormattedDate(
  dateString: string | undefined | null,
  options?: Intl.DateTimeFormatOptions,
  placeholder: string = '--'
): string {
  const isClient = useIsClient();

  if (!dateString || !isClient) {
    return placeholder;
  }

  try {
    return new Date(dateString).toLocaleDateString('en-US', options);
  } catch {
    return placeholder;
  }
}

/**
 * Format a relative time string (e.g., "5 minutes ago") in a hydration-safe way.
 * Returns a placeholder during SSR, then calculates relative time on client.
 *
 * @param dateString - ISO date string
 * @param placeholder - Placeholder text during SSR
 */
export function useRelativeTime(
  dateString: string | undefined | null,
  placeholder: string = '--'
): string {
  const clientDate = useClientDate(60000); // Refresh every minute

  if (!dateString || !clientDate) {
    return placeholder;
  }

  try {
    const date = new Date(dateString);
    const diffMs = clientDate.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffSecs < 60) return 'Just now';
    if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
    if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return placeholder;
  }
}

