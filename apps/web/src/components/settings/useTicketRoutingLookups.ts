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
}

async function readJson(url: string): Promise<unknown> {
  try {
    const res = await fetchWithAuth(url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/**
 * Select options for the rule drawer and the test panel, from the endpoints the
 * other ticket settings use: GET /users, GET /ticket-categories and the
 * `statuses` list of GET /ticket-config. Each degrades independently to an empty
 * list — the pickers then offer only "no change".
 */
export function useTicketRoutingLookups(): RoutingLookups {
  const [lookups, setLookups] = useState<RoutingLookups>({ users: [], categories: [], statuses: [] });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [usersBody, catBody, cfgBody] = await Promise.all([
        readJson('/users'),
        readJson('/ticket-categories'),
        readJson('/ticket-config'),
      ]);
      if (cancelled) return;
      const rows = (b: unknown): unknown[] => {
        if (Array.isArray(b)) return b;
        const data = (b as { data?: unknown } | null)?.data;
        return Array.isArray(data) ? data : [];
      };
      const users = (rows(usersBody) as LookupUser[]).filter((u) => u?.id);
      const categories = (rows(catBody) as Array<LookupCategory & { isActive?: boolean }>).filter(
        (c) => c?.id && c.isActive !== false,
      );
      const rawStatuses = (cfgBody as { data?: { statuses?: Array<LookupStatus & { isActive?: boolean }> } } | null)
        ?.data?.statuses;
      const statuses = (rawStatuses ?? []).filter(
        (s) => s?.id && s.isActive !== false && ROUTING_SETTABLE_CORE_STATUSES.includes(s.coreStatus),
      );
      setLookups({ users, categories, statuses });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return lookups;
}
