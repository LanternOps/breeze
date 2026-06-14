/**
 * Cached ticket-configuration client.
 *
 * Fetches `GET /ticket-config` and stores the in-flight/resolved promise at
 * module scope so multiple islands on the same page share a single network
 * request. A failed fetch (null result) is NOT cached — the next caller will
 * retry. A successful fetch is cached until `invalidateTicketConfig()` is
 * called (settings pages call it after writing config changes).
 */
import { fetchWithAuth } from '../stores/auth';
import {
  statusConfig,
  priorityConfig,
  type TicketStatus,
  type TicketPriority,
} from '../components/tickets/ticketConfig';

// Re-export the types we alias as CoreStatus / Priority in the spec.
export type CoreStatus = TicketStatus;
export type Priority = TicketPriority;

export interface TicketStatusRow {
  id: string;
  name: string;
  coreStatus: CoreStatus;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
}

export interface PrioritySetting {
  label: string | null;
  responseSlaMinutes: number | null;
  resolutionSlaMinutes: number | null;
}

export interface TicketConfig {
  statuses: TicketStatusRow[];
  priorities: Record<Priority, PrioritySetting>;
}

// The canonical order of core statuses (new → closed).
// Derived from the static statusConfig key order rather than duplicated.
const CORE_STATUS_ORDER: CoreStatus[] = Object.keys(statusConfig) as CoreStatus[];

// ─── Module-level cache ──────────────────────────────────────────────────────

// Stores the pending/resolved promise. Cleared on failure or by invalidate().
let cachedPromise: Promise<TicketConfig | null> | null = null;

// ─── API response shape (internal, not exported) ─────────────────────────────

interface ApiStatusRow {
  id: string;
  partnerId: string;
  name: string;
  coreStatus: CoreStatus;
  color: string | null;
  sortOrder: number;
  isSystem: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ApiResponse {
  data: {
    statuses: ApiStatusRow[];
    priorities: Record<Priority, { label: string | null; responseSlaMinutes: number | null; resolutionSlaMinutes: number | null }>;
  };
}

// ─── Fetch logic ─────────────────────────────────────────────────────────────

async function doFetch(): Promise<TicketConfig | null> {
  try {
    const response = await fetchWithAuth('/ticket-config');
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as ApiResponse;
    const config: TicketConfig = {
      statuses: body.data.statuses.map((row) => ({
        id: row.id,
        name: row.name,
        coreStatus: row.coreStatus,
        color: row.color,
        sortOrder: row.sortOrder,
        isSystem: row.isSystem,
        isActive: row.isActive,
      })),
      priorities: body.data.priorities,
    };
    return config;
  } catch {
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Returns the ticket configuration for the current partner, cached at module
 * scope for the page lifetime. Returns null on any failure; callers must fall
 * back to static config.
 *
 * Failed fetches are not cached — the next call retries automatically.
 */
export async function fetchTicketConfig(): Promise<TicketConfig | null> {
  if (cachedPromise !== null) {
    return cachedPromise;
  }

  const promise = doFetch().then((result) => {
    // If the fetch failed, clear the cache so the next caller retries.
    if (result === null) {
      cachedPromise = null;
    }
    return result;
  });

  cachedPromise = promise;
  return promise;
}

/**
 * Clears the module-level cache. Settings pages should call this after
 * successfully writing a config change so the next read reflects the update.
 */
export function invalidateTicketConfig(): void {
  cachedPromise = null;
}

/**
 * Test-only: resets the module-level cache so each test starts clean.
 * Production callers should use invalidateTicketConfig() instead.
 */
export function __resetTicketConfigCacheForTests(): void {
  cachedPromise = null;
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/**
 * Returns the display label for a status.
 *
 * Fallback chain:
 *   1. `statusName` (explicit override, e.g. a custom status name from the DB row)
 *   2. The system row name from config for the given coreStatus
 *   3. The static statusConfig label (always defined)
 */
export function statusLabel(
  config: TicketConfig | null,
  coreStatus: CoreStatus,
  statusName?: string | null,
): string {
  if (statusName) return statusName;
  if (config) {
    const systemRow = config.statuses.find((s) => s.coreStatus === coreStatus && s.isSystem);
    if (systemRow) return systemRow.name;
  }
  return statusConfig[coreStatus].label;
}

/**
 * Returns the display label for a priority.
 *
 * Fallback chain:
 *   1. Config label (non-null)
 *   2. The static priorityConfig label (always defined)
 */
export function priorityLabel(config: TicketConfig | null, priority: Priority): string {
  if (config) {
    const setting = config.priorities[priority];
    if (setting?.label) return setting.label;
  }
  return priorityConfig[priority].label;
}

/**
 * Groups active statuses by their coreStatus in canonical order (new → closed),
 * with statuses within each group sorted by sortOrder ascending.
 *
 * Returns all six core groups, even if a group has no active statuses.
 */
export function activeStatusesByCore(
  config: TicketConfig,
): Array<{ coreStatus: CoreStatus; statuses: TicketStatusRow[] }> {
  const activeStatuses = config.statuses.filter((s) => s.isActive);

  return CORE_STATUS_ORDER.map((coreStatus) => ({
    coreStatus,
    statuses: activeStatuses
      .filter((s) => s.coreStatus === coreStatus)
      .sort((a, b) => a.sortOrder - b.sortOrder),
  }));
}
