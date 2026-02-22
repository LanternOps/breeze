import { z } from 'zod';
import { networkChangeEvents } from '../db/schema';
import type { AuthContext } from '../middleware/auth';

/**
 * Shared constants, schemas, and utilities for network baseline and change routes.
 */

export const networkEventTypes = ['new_device', 'device_disappeared', 'device_changed', 'rogue_device'] as const;

export const optionalQueryBooleanSchema = z.preprocess((value) => {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean().optional());

export function mapNetworkChangeRow(row: typeof networkChangeEvents.$inferSelect) {
  return {
    ...row,
    detectedAt: row.detectedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

/**
 * Resolve the effective orgId from the authenticated context and an optional
 * caller-supplied orgId.  Returns either `{ orgId }` or `{ error, status }`.
 *
 * - Organization-scoped users are locked to their own org.
 * - Partner-scoped users may supply an orgId they can access; if omitted and
 *   they only manage one org it is auto-selected.
 * - System-scoped users may supply any orgId; when `requireForNonOrg` is true
 *   an orgId is mandatory.
 */
export function resolveOrgId(
  auth: AuthContext,
  requestedOrgId?: string,
  requireForNonOrg = false
):
  | { orgId: string | null }
  | { error: string; status: 400 | 403 } {
  if (auth.scope === 'organization') {
    if (!auth.orgId) {
      return { error: 'Organization context required', status: 403 };
    }
    if (requestedOrgId && requestedOrgId !== auth.orgId) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: auth.orgId };
  }

  if (requestedOrgId) {
    if (!auth.canAccessOrg(requestedOrgId)) {
      return { error: 'Access to this organization denied', status: 403 };
    }
    return { orgId: requestedOrgId };
  }

  if (auth.scope === 'partner') {
    const orgIds = auth.accessibleOrgIds ?? [];
    if (!requireForNonOrg && orgIds.length === 1) {
      return { orgId: orgIds[0] ?? null };
    }
    if (requireForNonOrg) {
      return { error: 'orgId is required for partner scope', status: 400 };
    }
    return { orgId: null };
  }

  if (auth.scope === 'system') {
    if (requireForNonOrg && !requestedOrgId) {
      return { error: 'orgId is required for system scope', status: 400 };
    }
    return { orgId: requestedOrgId ?? null };
  }

  return { error: 'Access denied', status: 403 };
}
