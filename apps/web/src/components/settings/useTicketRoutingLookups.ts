import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { ROUTING_SETTABLE_CORE_STATUSES } from './ticketRoutingModel';

export interface LookupUser {
  id: string;
  name: string | null;
  email: string;
}
export interface LookupCategory {
  id: string;
  name: string;
}
export interface LookupStatus {
  id: string;
  name: string;
  coreStatus: string;
}

export interface RoutingLookups {
  users: LookupUser[];
  categories: LookupCategory[];
  /** Active statuses a rule may set (core new / open / pending / on_hold). */
  statuses: LookupStatus[];
  /** True when any of the three reads failed: the pickers are then incomplete, not empty by design. */
  loadFailed: boolean;
}

const FAILED = Symbol('lookup-failed');

async function readJson(url: string): Promise<unknown> {
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) {
      console.warn(`[ticket-routing] lookup ${url} failed: HTTP ${res.status}`);
      return FAILED;
    }
    return await res.json();
  } catch (err) {
    console.warn(`[ticket-routing] lookup ${url} failed`, err);
    return FAILED;
  }
}

/**
 * Select options for the rule drawer and the test panel, from the endpoints the
 * other ticket settings use: GET /users, GET /ticket-categories and the
 * `statuses` list of GET /ticket-config. Each degrades independently to an empty
 * list, and `loadFailed` tells the tab to say so (a failed read must not look
 * like "no users" or make an existing reference look unavailable).
 */
export function useTicketRoutingLookups(): RoutingLookups {
  const [lookups, setLookups] = useState<RoutingLookups>({ users: [], categories: [], statuses: [], loadFailed: false });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [usersBody, catBody, cfgBody] = await Promise.all([
        readJson('/users'),
        readJson('/ticket-categories'),
        readJson('/ticket-config'),
      ]);
      if (cancelled) return;
      const loadFailed = [usersBody, catBody, cfgBody].some((b) => b === FAILED);
      const rows = (b: unknown): unknown[] => {
        if (Array.isArray(b)) return b;
        if (b === FAILED) return [];
        const data = (b as { data?: unknown } | null)?.data;
        return Array.isArray(data) ? data : [];
      };
      const users = (rows(usersBody) as LookupUser[]).filter((u) => u?.id);
      const categories = (rows(catBody) as Array<LookupCategory & { isActive?: boolean }>).filter(
        (c) => c?.id && c.isActive !== false,
      );
      const rawStatuses = cfgBody === FAILED ? undefined : (cfgBody as { data?: { statuses?: Array<LookupStatus & { isActive?: boolean }> } } | null)
        ?.data?.statuses;
      const statuses = (rawStatuses ?? []).filter(
        (s) => s?.id && s.isActive !== false && ROUTING_SETTABLE_CORE_STATUSES.includes(s.coreStatus),
      );
      setLookups({ users, categories, statuses, loadFailed });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return lookups;
}
